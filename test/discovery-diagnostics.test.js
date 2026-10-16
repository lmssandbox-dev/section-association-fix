'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDiagnostics } = require('../src/dates/discoveryDiagnostics');
function response(token = { user: 'developer', deploymentId: 'deployment' }) {
  return { locals: { token, ltik: 'session-token' }, headers: {}, code: 200,
    set(key, value) { this.headers[key] = value; return this; },
    status(code) { this.code = code; return this; },
    send(body) { this.body = body; return this; }, json(body) { this.body = body; return this; } };
}
function setup() {
  const calls = [];
  const handlers = createDiagnostics({ deploymentId: 'deployment',
    client: { async discover(...args) { calls.push(args); return { activities: [{ name: '<script>alert(1)</script>' }], complete: true, orgUnitId: "999", counts: {}, warnings: [] }; } } });
  return { calls, ...handlers };
}

test('missing or wrong validated deployment blocks API calls', async () => {
  const { activities, calls } = setup();
  for (const token of [null, { user: 'developer', deploymentId: 'other' }, { user: 'developer' }]) {
    const res = response(token);
    await activities({ query: { orgUnitId: '999', user: 'developer', deploymentId: 'deployment' } }, res);
    assert.equal(res.code, 403);
    assert.equal(res.headers['Cache-Control'], 'no-store');
  }
  assert.equal(calls.length, 0);
});

test('any LMS-authorized user in the configured deployment can discover activities', async () => {
  const { activities, calls } = setup();
  for (const user of ['admin-one', 'admin-two']) {
    const res = response({ user, deploymentId: 'deployment' });
    await activities({ query: { orgUnitId: '999', format: 'json' } }, res);
    assert.equal(res.code, 200);
    assert.ok(Array.isArray(res.body.activities));
  }
  assert.equal(calls.length, 2);
});

test('missing deployment configuration blocks access before API calls', async () => {
  const res = response();
  const handlers = createDiagnostics({ client: { discover() { assert.fail('Unexpected API call'); } } });
  await handlers.activities({ query: { orgUnitId: '999' } }, res);
  assert.equal(res.code, 503);
});

test('launch replaces old API demo with a form and performs no API reads', () => {
  const { launch, calls } = setup(); const res = response();
  launch(res.locals.token, {}, res);
  assert.match(res.body, /name="orgUnitId"/);
  assert.match(res.body, /name="ltik" value="session-token"/);
  assert.equal(calls.length, 0);
});

test('diagnostic validates input, supports JSON and raw opt-in', async () => {
  const { activities, calls } = setup();
  const invalid = response(); await activities({ query: { orgUnitId: ['999'] } }, invalid);
  assert.equal(invalid.code, 400); assert.equal(calls.length, 0);
  const res = response();
  await activities({ query: { orgUnitId: '999', raw: '1', format: 'json' } }, res);
  assert.deepEqual(calls, [['999', { includeRaw: true, includeUndated: false }]]);
  assert.ok(Array.isArray(res.body.activities));
});

test('HTML escapes activity data and default reads omit raw', async () => {
  const { activities, calls } = setup(); const res = response();
  await activities({ query: { orgUnitId: '999' } }, res);
  assert.ok(!res.body.includes('<script>')); assert.match(res.body, /&lt;script&gt;/);
  assert.equal(calls[0][1].includeRaw, false);
});

test('failed reads return 502 without exposing upstream error text', async () => {
  const { activities } = createDiagnostics({ deploymentId: 'deployment',
    client: { async discover() { throw new Error('SECRET'); } } });
  const res = response(); await activities({ query: { orgUnitId: '999' } }, res);
  assert.equal(res.code, 502); assert.equal(JSON.stringify(res.body).includes('SECRET'), false);
});


test('diagnostic can include undated activities and identifies partial results', async () => {
  const calls = [];
  const { activities } = createDiagnostics({ deploymentId: 'deployment', client: { async discover(...args) {
    calls.push(args); return { orgUnitId: '999', complete: false, counts: {}, activities: [], warnings: [{ source: 'quizzes', code: 'API_READ_FAILED', message: 'Unable to read quizzes.' }] };
  } } });
  const res = response();
  await activities({ query: { orgUnitId: '999', includeUndated: '1' } }, res);
  assert.equal(calls[0][1].includeUndated, true);
  assert.match(res.body, /Partial discovery/);
  assert.doesNotMatch(res.body, /Content structure|Content relationships/);
});

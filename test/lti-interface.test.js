'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { registerSectionAssociationLtiInterface } = require('../src/sectionAssociations/ltiInterface');

function setup(getStatus = async () => ({ availability: 'Available', worker: 'idle', latestExecution: null })) {
  const routes = {};
  let onConnect;
  const provider = { app: { get(path, handler) { routes[path] = handler; } }, onConnect(handler) { onConnect = handler; } };
  registerSectionAssociationLtiInterface(provider, { deploymentId: 'deployment-1', getStatus });
  return { routes, onConnect };
}

function response() {
  return { locals: {}, headers: {}, statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    set(name, value) { this.headers[name] = value; return this; },
    type(value) { this.contentType = value; return this; },
    json(value) { this.body = value; return this; },
    send(value) { this.body = value; return this; } };
}

test('status route uses the verified deployment and returns no-cache process status', async () => {
  let reads = 0;
  const { routes } = setup(async () => { reads++; return { availability: 'Available', worker: 'idle', latestExecution: null }; });
  const res = response();
  res.locals.token = { deploymentId: 'deployment-1' };
  await routes['/api/section-association/status']({}, res);
  assert.equal(reads, 1);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(res.body.worker, 'idle');
});

test('status route rejects a mismatched deployment before reading status', async () => {
  let reads = 0;
  const { routes } = setup(async () => { reads++; return {}; });
  const res = response();
  res.locals.token = { deploymentId: 'other' };
  await routes['/api/section-association/status']({}, res);
  assert.equal(res.statusCode, 403);
  assert.equal(reads, 0);
});

test('LTI launch returns the minimal read-only interface for its verified deployment', () => {
  const { onConnect } = setup();
  const res = response();
  onConnect({ deploymentId: 'deployment-1' }, {}, res);
  assert.equal(res.contentType, 'html');
  assert.match(res.body, /Service status/);
  assert.match(res.body, /Latest execution/);
  assert.match(res.body, /Refresh/);
  assert.match(res.body, /CSV report[\s\S]*Unavailable/);
  assert.match(res.body, /Validation and corrective actions are not available/);
  assert.doesNotMatch(res.body, /cancel|run correction/i);
});

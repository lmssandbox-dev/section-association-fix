'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { registerSectionAssociationLtiInterface, pageForLaunch } = require('../src/sectionAssociations/ltiInterface');

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
  const savedExecution = { executionId: 'run-1', source: 'manual', status: 'completed', startedAt: new Date(10), completedAt: new Date(20) };
  const { routes } = setup(async () => { reads++; return { availability: 'Available', worker: 'idle', latestExecution: savedExecution }; });
  const res = response();
  res.locals.token = { deploymentId: 'deployment-1' };
  await routes['/api/section-association/status']({}, res);
  assert.equal(reads, 1);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(res.body.worker, 'idle');
  assert.equal(res.body.latestExecution, savedExecution);
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

test('status route reports temporary status-source failures as service unavailable', async () => {
  const { routes } = setup(async () => { throw new Error('internal detail'); });
  const res = response();
  res.locals.token = { deploymentId: 'deployment-1' };
  await routes['/api/section-association/status']({}, res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.availability, 'Unavailable');
});

test('LTI launch returns the interface with its ltijs request token for subsequent authenticated fetches', () => {
  const { onConnect } = setup();
  const res = response();
  res.locals.ltik = 'signed-lti-token';
  onConnect({ deploymentId: 'deployment-1' }, {}, res);
  assert.equal(res.contentType, 'html');
  assert.match(res.body, /Service status/);
  assert.match(res.body, /Latest execution/);
  assert.match(res.body, /Refresh/);
  assert.match(res.body, /Authorization:'Bearer '\+ltiToken/);
  assert.match(res.body, /credentials:'same-origin'/);
  assert.doesNotMatch(res.body, /CSV report|Validation and corrective actions are not available/);
  assert.match(res.body, /Remaining historical backlog/);
  assert.match(res.body, /Last updated/);
  assert.match(res.body, /@media\(max-width:520px\)/);
  assert.match(res.body, /repeat\(2,minmax\(0,1fr\)\)/);
  assert.doesNotMatch(res.body, /cancel|run correction/i);
});

test('LTI launch without ltijs request token cannot render an unusable page', () => {
  const { onConnect } = setup();
  const res = response();
  onConnect({ deploymentId: 'deployment-1' }, {}, res);
  assert.equal(res.statusCode, 401);
  assert.match(res.body, /Relaunch this tool from Brightspace/);
});

async function runPage(fetchImpl) {
  const html = pageForLaunch('signed-lti-token');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const ids = ['availability', 'worker', 'executionMeta', 'latestDate', 'outcome', 'source', 'metrics', 'empty',
    'checked', 'compliant', 'corrections', 'errors', 'backlogMetric', 'backlog', 'coverageNote', 'updated', 'notice', 'refresh'];
  let finish;
  const finished = new Promise(resolve => { finish = resolve; });
  const elements = Object.fromEntries(ids.map(id => [id, {
    value: id === 'empty' ? 'No maintenance execution recorded yet.' : '',
    hidden: ['executionMeta', 'metrics', 'empty', 'coverageNote'].includes(id),
    className: id === 'backlogMetric' ? 'metric backlog' : '',
    listeners: {},
    addEventListener(event, handler) { this.listeners[event] = handler; },
    set textContent(value) { this.value = value; if (id === 'notice' && value !== 'Refreshing…') finish(); },
    get textContent() { return this.value; }
  }]));
  vm.runInNewContext(script, { document: { getElementById: id => elements[id] }, fetch: fetchImpl });
  await finished;
  return elements;
}

test('status fetch sends the launch token in ltijs-supported Authorization header and renders data', async () => {
  let request;
  const elements = await runPage(async (...args) => {
    request = args;
    return { ok: true, async json() { return { availability: 'Available', worker: 'idle', latestExecution: null }; } };
  });
  assert.equal(request[0], '/api/section-association/status');
  assert.equal(request[1].credentials, 'same-origin');
  assert.equal(request[1].headers.Authorization, 'Bearer signed-lti-token');
  assert.equal(elements.worker.textContent, 'Idle');
  assert.equal(elements.empty.textContent, 'No maintenance execution recorded yet.');
  assert.equal(elements.empty.hidden, false);
  assert.equal(elements.metrics.hidden, true);
  assert.equal(elements.checked.textContent, '—');
  assert.match(elements.updated.textContent, /^Last updated /);
});

test('Refresh performs another authenticated status request', async () => {
  let requests = 0;
  const elements = await runPage(async () => {
    requests++;
    return { ok: true, async json() { return { availability: 'Available', worker: 'idle', latestExecution: null }; } };
  });
  await elements.refresh.listeners.click();
  assert.equal(requests, 2);
  assert.match(elements.updated.textContent, /^Last updated /);
});

test('latest manual execution renders the persisted date, outcome, source and metrics', async () => {
  const execution = { source: 'manual', startedAt: '2026-10-17T10:00:00.000Z', completedAt: '2026-10-17T10:02:00.000Z',
    status: 'completed', associationsChecked: 3, alreadyCompliant: 1, correctionsApplied: 1, errors: 0,
    coverage: { type: 'bounded-cycle', remainingHistoricalBacklog: 4 } };
  const elements = await runPage(async () => ({ ok: true, async json() {
    return { availability: 'Available', worker: 'idle', latestExecution: execution };
  } }));
  assert.equal(elements.executionMeta.hidden, false);
  assert.match(elements.latestDate.textContent, /2026/);
  assert.equal(elements.outcome.textContent, 'Completed');
  assert.equal(elements.source.textContent, 'Manual maintenance');
  assert.equal(elements.checked.textContent, '3');
  assert.equal(elements.compliant.textContent, '1');
  assert.equal(elements.corrections.textContent, '1');
  assert.equal(elements.errors.textContent, '0');
  assert.equal(elements.backlog.textContent, '4');
  assert.match(elements.backlogMetric.className, /backlog/);
  assert.equal(elements.coverageNote.hidden, false);
  assert.match(elements.coverageNote.textContent, /full-scan completion is not tracked/);
});

test('automatic execution displays a neutral placeholder when historical backlog is not supplied', async () => {
  const execution = { source: 'automatic', startedAt: '2026-10-17T10:00:00.000Z', status: 'failed',
    associationsChecked: 2, alreadyCompliant: 0, correctionsApplied: 0, errors: 1 };
  const elements = await runPage(async () => ({ ok: true, async json() {
    return { availability: 'Available', worker: 'error', latestExecution: execution };
  } }));
  assert.equal(elements.source.textContent, 'Automatic maintenance');
  assert.equal(elements.outcome.textContent, 'Failed');
  assert.equal(elements.backlog.textContent, '—');
  assert.equal(elements.coverageNote.hidden, true);
  assert.equal(elements.worker.textContent, 'Error');
});

test('authentication and temporary server failures clear loading fields and explain the failure', async () => {
  for (const [status, expectedNotice, expectedWorker] of [
    [401, /LTI session expired.*Relaunch/, 'Authentication Required'],
    [403, /deployment is not authorized/, 'Not Authorized'],
    [503, /temporarily unavailable.*Retry shortly/, 'Unavailable']
  ]) {
    const elements = await runPage(async () => ({ ok: false, status }));
    assert.match(elements.notice.textContent, expectedNotice);
    assert.equal(elements.worker.textContent, expectedWorker);
    for (const id of ['availability', 'latestDate', 'outcome', 'source', 'checked', 'compliant', 'corrections', 'errors', 'backlog']) {
      assert.notEqual(elements[id].textContent, 'Loading');
    }
    assert.equal(elements.metrics.hidden, true);
    assert.equal(elements.executionMeta.hidden, true);
  }
});

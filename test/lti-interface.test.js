'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { registerSectionAssociationLtiInterface, pageForLaunch, csvCell } = require('../src/sectionAssociations/ltiInterface');

function setup(getStatus = async () => ({ availability: 'Available', worker: 'idle', latestExecution: null, executions: [] }), getExecutionHistory = async function *() {}) {
  const routes = {}; let onConnect;
  const provider = { app: { get(path, handler) { routes[path] = handler; } }, onConnect(handler) { onConnect = handler; } };
  registerSectionAssociationLtiInterface(provider, { deploymentId: 'deployment-1', getStatus, getExecutionHistory });
  return { routes, onConnect };
}

function response() {
  return { locals: {}, headers: {}, statusCode: 200, body: '', chunks: [],
    status(code) { this.statusCode = code; return this; },
    set(name, value) { this.headers[name] = value; return this; },
    type(value) { this.contentType = value; return this; },
    json(value) { this.body = value; return this; },
    send(value) { this.body = value; return this; },
    write(value) { this.chunks.push(value); return true; }, end() { this.ended = true; } };
}

test('status route returns no-cache status only after deployment verification', async () => {
  let reads = 0;
  const latestExecution = { executionId: 'run-1', source: 'manual', status: 'completed', startedAt: new Date(10), completedAt: new Date(20) };
  const { routes } = setup(async () => { reads++; return { availability: 'Available', worker: 'idle', latestExecution, executions: [latestExecution] }; });
  const res = response(); res.locals.token = { deploymentId: 'deployment-1' };
  await routes['/api/section-association/status']({}, res);
  assert.equal(reads, 1); assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(res.body.latestExecution, latestExecution);
  const denied = response(); denied.locals.token = { deploymentId: 'other' };
  await routes['/api/section-association/status']({}, denied);
  assert.equal(denied.statusCode, 403); assert.equal(reads, 1);
});

test('status route reports temporary status-source failures', async () => {
  const { routes } = setup(async () => { throw new Error('internal detail'); });
  const res = response(); res.locals.token = { deploymentId: 'deployment-1' };
  await routes['/api/section-association/status']({}, res);
  assert.equal(res.statusCode, 503); assert.equal(res.body.availability, 'Unavailable');
});

test('launch page is a compact responsive monitor with authenticated refresh and expandable history', () => {
  const { onConnect } = setup(); const res = response(); res.locals.ltik = 'signed-lti-token';
  onConnect({ deploymentId: 'deployment-1' }, {}, res);
  assert.equal(res.contentType, 'html');
  for (const text of ['Service status', 'Current worker state', 'Execution history', 'Download CSV', 'Associations checked', 'Corrections applied', 'Errors']) assert.ok(res.body.includes(text));
  assert.match(res.body, /Authorization:'Bearer '\+ltiToken/); assert.match(res.body, /credentials:'same-origin'/);
  assert.match(res.body, /slice\(0,50\)/); assert.match(res.body, /@media\(max-width:620px\)/);
  assert.match(res.body, /role="columnheader"/); assert.match(res.body, /data-label="Corrections"/);
  assert.match(res.body, /font-variant-numeric:tabular-nums/); assert.match(res.body, /id="exportFeedback" role="status" aria-live="polite"/);
  assert.match(res.body, /\.history-head\{display:none\}/); assert.match(res.body, /\.execution-summary \.numeric::before\{content:attr\(data-label\)/);
  assert.match(res.body, /\.history-row\{display:grid;grid-template-columns:/);
  assert.match(res.body, /<details class="execution"><summary class="history-row execution-summary">/);
  assert.doesNotMatch(res.body, /Next scheduled execution|Latest execution<|backlogProgress|CSV report placeholder|corrective action/i);
  assert.match(res.body, /historyEmpty/); assert.match(res.body, /executionHtml/);
});

const execution = { executionId: 'run-1', source: 'manual', startedAt: '2026-10-17T10:00:00.000Z', completedAt: '2026-10-17T10:02:00.000Z',
  status: 'completed', associationsChecked: 1234, alreadyCompliant: 1, correctionsApplied: 1, errors: 0,
  coverage: { type: 'bounded-cycle', remainingHistoricalBacklog: 4 } };

async function runPage(fetchImpl) {
  const script = pageForLaunch('signed-lti-token').match(/<script>([\s\S]*?)<\/script>/)[1];
  const ids = ['availability','worker','latest','latestDate','outcome','source','checked','corrections','errors','emptyLatest','historyEmpty','history','updated','notice','refresh','export','exportFeedback'];
  let finish; const finished = new Promise(resolve => { finish = resolve; });
  const links=[];
  const elements = Object.fromEntries(ids.map(id => [id, { value: '', hidden: ['latest','emptyLatest','historyEmpty'].includes(id), className: '', innerHTML: '', listeners: {},
    addEventListener(event, handler) { this.listeners[event] = handler; }, setAttribute(name,value) { this[name]=value; },
    set textContent(value) { this.value = value; if (id === 'notice' && value !== 'Refreshing…') finish(); }, get textContent() { return this.value; } }]));
  vm.runInNewContext(script, { document: { getElementById: id => elements[id], createElement() { const link={click(){link.clicked=true}}; links.push(link); return link; } }, fetch: fetchImpl,
    Intl, Date, URL: { createObjectURL() { return 'blob:url'; }, revokeObjectURL() {} } });
  await finished; elements.links=links; return elements;
}

test('Refresh renders latest status and 50-row history, including expandable details', async () => {
  const runs = [execution, { ...execution, executionId: '<unsafe>', source: 'automatic', startedAt: '2026-10-16T10:00:00Z', completedAt: '2026-10-16T10:00:01Z' }];
  let request;
  const elements = await runPage(async (...args) => { request = args; return { ok: true, async json() { return { availability: 'Available', worker: 'idle', latestExecution: execution, executions: runs }; } }; });
  assert.equal(request[0], '/api/section-association/status'); assert.equal(request[1].headers.Authorization, 'Bearer signed-lti-token');
  assert.equal(request[1].credentials, 'same-origin'); assert.equal(elements.checked.textContent, '1,234');
  assert.equal(elements.source.textContent, 'Manual'); assert.equal(elements.historyEmpty.hidden, true);
  assert.equal(elements.outcome.className, 'outcome completed'); assert.equal(elements.outcome['aria-label'], 'Outcome: Completed');
  assert.match(elements.history.innerHTML, /Already compliant/); assert.match(elements.history.innerHTML, /Errors/); assert.match(elements.history.innerHTML, /&lt;unsafe&gt;/);
  assert.match(elements.history.innerHTML, /aria-label="Outcome: Completed"/); assert.match(elements.history.innerHTML, /data-label="Corrections"[^>]*>1<\/span>/);
  assert.match(elements.updated.textContent, /^Last refreshed /);
});

test('Refresh supports empty history and can be repeated', async () => {
  let calls = 0;
  const elements = await runPage(async () => { calls++; return { ok: true, async json() { return { availability: 'Available', worker: 'idle', latestExecution: null, executions: [] }; } }; });
  assert.equal(elements.emptyLatest.hidden, false); assert.equal(elements.historyEmpty.hidden, false);
  await elements.refresh.listeners.click(); assert.equal(calls, 2);
});

test('Download CSV keeps success feedback beside its control', async () => {
  let request;
  const elements = await runPage(async (...args) => {
    request=args;
    if (request[0].endsWith('.csv')) return { ok:true, async blob(){return {}}, headers:{get(){return 'attachment; filename="section-association-executions-2026-10-17.csv"'}} };
    return {ok:true,async json(){return {availability:'Available',worker:'idle',latestExecution:null,executions:[]}}};
  });
  await elements.export.listeners.click();
  assert.equal(request[0], '/api/section-association/executions.csv');
  assert.equal(request[1].credentials, 'same-origin'); assert.equal(request[1].headers.Authorization, 'Bearer signed-lti-token');
  assert.equal(elements.exportFeedback.textContent, 'CSV downloaded.'); assert.equal(elements.exportFeedback.className, 'feedback success');
  assert.equal(elements.links[0].clicked, true);
});

test('Download CSV shows an accessible inline error when the request is denied', async () => {
  const elements = await runPage(async url => url.endsWith('.csv') ? {ok:false,status:403} :
    {ok:true,async json(){return {availability:'Available',worker:'idle',latestExecution:null,executions:[]}}});
  await elements.export.listeners.click();
  assert.equal(elements.exportFeedback.textContent, 'Deployment not authorized.');
  assert.equal(elements.exportFeedback.className, 'feedback error');
});

test('CSV endpoint is authenticated, streams all execution rows, and quotes CSV safely', async () => {
  const { routes } = setup(undefined, async function *() {
    yield execution; yield { executionId: 'run,"2', source: 'automatic', startedAt: null, status: 'failed' };
    for (let i = 2; i < 65; i++) yield { executionId: `run-${i}`, source: i % 2 ? 'manual' : 'automatic', status: 'completed' };
  });
  const denied = response(); denied.locals.token = { deploymentId: 'wrong' };
  await routes['/api/section-association/executions.csv']({}, denied);
  assert.equal(denied.statusCode, 403); assert.equal(denied.chunks.length, 0);
  const res = response(); res.locals.token = { deploymentId: 'deployment-1' };
  await routes['/api/section-association/executions.csv']({}, res);
  assert.equal(res.headers['Cache-Control'], 'no-store'); assert.match(res.headers['Content-Disposition'], /section-association-executions-\d{4}-\d{2}-\d{2}\.csv/);
  assert.equal(res.ended, true); assert.equal(res.chunks.length, 66);
  assert.match(res.chunks[0], /Execution ID.*Historical backlog remaining.*Coverage/);
  assert.match(res.chunks[2], /"run,""2"/); assert.match(res.chunks[2], /"","","failed"/);
  assert.equal(csvCell('a,"b'), '"a,""b"'); assert.equal(csvCell(undefined), '""');
});

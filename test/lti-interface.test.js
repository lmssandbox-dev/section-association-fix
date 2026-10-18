'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { registerSectionAssociationLtiInterface, pageForLaunch, csvCell, auditCsvCell } = require('../src/sectionAssociations/ltiInterface');

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
  for (const text of ['Service status', 'Current worker state', 'Discovery periods', 'Current academic period', 'Previous academic period', 'Last execution', 'Execution history', 'Periods / Scope', 'Export History CSV']) assert.ok(res.body.includes(text));
  assert.doesNotMatch(res.body, /<span class="label">Source<\/span>|latestMetrics|zeroWork/);
  assert.match(res.body, /title="Current academic period"/);assert.match(res.body, /title="Previous academic period"/);
  assert.match(res.body, /\.period-chip\{display:inline-flex/);assert.match(res.body, /\.scope\{overflow-wrap:anywhere;white-space:nowrap\}/);
  assert.doesNotMatch(res.body, />Download CSV</);
  assert.match(res.body, /Authorization:'Bearer '\+ltiToken/); assert.match(res.body, /credentials:'same-origin'/);
  assert.match(res.body, /slice\(0,50\)/); assert.match(res.body, /@media\(max-width:620px\)/);
  assert.match(res.body, /role="columnheader"/); assert.match(res.body, /data-label="Corrections"/);
  assert.match(res.body, /font-variant-numeric:tabular-nums/); assert.match(res.body, /id="exportFeedback" role="status" aria-live="polite"/);
  assert.match(res.body, /\.history-head\{display:none\}/); assert.match(res.body, /\.execution-summary \.numeric::before\{content:attr\(data-label\)/);
  assert.match(res.body, /\.history-row\{display:grid;grid-template-columns:/);
  assert.match(res.body, /section\{padding:14px 16px;margin:12px 0\}/);
  assert.match(res.body, /\.detail-strip\{display:flex;align-items:center;gap:10px;min-height:36px;margin:0 8px 8px 25px;padding:7px 10px/);
  assert.match(res.body, /\.latest-message:empty\{display:none\}/);
  assert.match(res.body, /function executionHtml\(run\)/);
  for (const removed of ['Historical backlog remaining','Bounded cycle','Execution ID']) assert.ok(!res.body.includes(removed));
  assert.doesNotMatch(res.body, /Next scheduled execution|Latest execution<|backlogProgress|CSV report placeholder|corrective action/i);
  assert.match(res.body, /historyEmpty/); assert.match(res.body, /executionHtml/);
});

const execution = { executionId: 'run-1', source: 'manual', startedAt: '2026-10-17T10:00:00.000Z', completedAt: '2026-10-17T10:02:00.000Z',
  status: 'completed', associationsChecked: 1234, alreadyCompliant: 1, correctionsApplied: 1, errors: 0,
  discoveryPeriods:{current:'2602',previous:'2601'}, discoveryActivities:{currentPrevious:true},
  coverage: { type: 'bounded-cycle', remainingHistoricalBacklog: 4 } };

async function runPage(fetchImpl) {
  const script = pageForLaunch('signed-lti-token').match(/<script>([\s\S]*?)<\/script>/)[1];
  const ids = ['availability','worker','currentPeriod','previousPeriod','latest','latestDate','outcome','latestMessage','emptyLatest','historyEmpty','history','updated','notice','refresh','export','exportFeedback'];
  let finish; const finished = new Promise(resolve => { finish = resolve; });const timers=[];
  const summary={focused:false,focus(){this.focused=true}},reportMenu={open:true,querySelector(){return summary}},reportFeedback={textContent:'',className:''},reportEntry={querySelector(){return reportFeedback}};
  const links=[];
  const elements = Object.fromEntries(ids.map(id => [id, { value: '', hidden: ['latest','emptyLatest','historyEmpty'].includes(id), className: '', innerHTML: '', listeners: {},
    addEventListener(event, handler) { this.listeners[event] = handler; }, setAttribute(name,value) { this[name]=value; },
    set textContent(value) { this.value = value; if (id === 'notice' && value !== 'Refreshing…') finish(); }, get textContent() { return this.value; } }]));
  const documentListeners={};
  vm.runInNewContext(script, { document: { getElementById: id => elements[id], addEventListener(event,handler){documentListeners[event]=handler}, querySelectorAll(){return reportMenu.open?[reportMenu]:[]}, querySelector(){return reportMenu.open?reportMenu:null}, createElement() { const link={click(){link.clicked=true}}; links.push(link); return link; } }, fetch: fetchImpl,
    Intl, Date, setTimeout(fn){timers.push(fn);return timers.length}, clearTimeout(){}, URL: { createObjectURL() { return 'blob:url'; }, revokeObjectURL() {} } });
  await finished; elements.links=links;elements.reportMenu=reportMenu;elements.reportSummary=summary;elements.reportFeedback=reportFeedback;elements.reportEntry=reportEntry;elements.documentListeners=documentListeners;elements.timers=timers; return elements;
}

test('Refresh renders latest status and 50-row history, including expandable details', async () => {
  const runs = [execution, { ...execution, executionId: '<unsafe>', source: 'automatic', startedAt: '2026-10-16T10:00:00Z', completedAt: '2026-10-16T10:00:01Z' }];
  let request;
  const elements = await runPage(async (...args) => { request = args; return { ok: true, async json() { return { availability: 'Available', worker: 'idle', latestExecution: execution, executions: runs }; } }; });
  assert.equal(request[0], '/api/section-association/status'); assert.equal(request[1].headers.Authorization, 'Bearer signed-lti-token');
  assert.equal(request[1].credentials, 'same-origin');
  assert.equal(elements.latestMessage.textContent, 'Checked: 1,234 · Corrections: 1 · Errors: 0');
  assert.equal(elements.historyEmpty.hidden, true);
  assert.equal(elements.currentPeriod.textContent, '—');assert.equal(elements.previousPeriod.textContent, '—');
  assert.match(elements.history.innerHTML, /<span class="scope">2602 · 2601<\/span>/);
  assert.doesNotMatch(elements.history.innerHTML, /<span class="source">/);
  assert.equal(elements.outcome.className, 'outcome completed'); assert.equal(elements.outcome['aria-label'], 'Outcome: Completed');
  assert.match(elements.history.innerHTML, /2602 · 2601/);
  assert.match(elements.history.innerHTML, /Already compliant: 1 · 2 min/);
  assert.match(elements.history.innerHTML,/Oct 17/);assert.doesNotMatch(elements.history.innerHTML,/Start time|Finish time/);
  const details = elements.history.innerHTML.match(/<div class="detail-strip">([\s\S]*?)<\/div><\/details>/)[1];
  assert.match(details,/Already compliant: 1 · 2 min/);
  assert.doesNotMatch(details,/Current \+ previous discovery|Historical discovery|Re-verification/);
  for (const removed of ['Start time','Finish time','detail-grid','<span class="label">Source</span>','<span class="label">Errors</span>']) assert.ok(!details.includes(removed));
  assert.match(responsiveStyles(),/\.detail-strip\{flex-wrap:wrap/);
  assert.match(elements.history.innerHTML, /aria-label="Outcome: Completed"/); assert.match(elements.history.innerHTML, /data-label="Corrections"[^>]*>1<\/span>/);
  assert.match(elements.history.innerHTML, /data-label="Errors"[^>]*>0<\/span>/);
  assert.match(elements.updated.textContent, /^Last refreshed /);
});

test('current service periods render from status data and use a neutral fallback for unavailable values', async () => {
  const payload={availability:'Available',worker:'idle',discoveryPeriods:{current:'2701',previous:'2602'},latestExecution:null,executions:[]};
  const elements=await runPage(async()=>({ok:true,async json(){return payload}}));
  assert.equal(elements.currentPeriod.textContent,'2701');assert.equal(elements.previousPeriod.textContent,'2602');
  const invalid=await runPage(async()=>({ok:true,async json(){return {...payload,discoveryPeriods:null}}}));
  assert.equal(invalid.currentPeriod.textContent,'—');assert.equal(invalid.previousPeriod.textContent,'—');
});

test('history scope shows recorded codes and expanded details avoid repeating periods', async()=>{
  const scopeCases=[
    [{currentPrevious:true},{current:'2602',previous:'2601'},'2602 · 2601','Already compliant: 1 · 2 min'],
    [{historical:true},null,'Historical','Already compliant: 1 · 2 min'],
    [{reverification:true},null,'Re-verification','Already compliant: 1 · 2 min'],
    [{currentPrevious:true,historical:true},{current:'2602',previous:'2601'},'2602 · 2601 · Mixed','Already compliant: 1 · 2 min'],
    [{},null,'—','Already compliant: 1']
  ];
  for(const [discoveryActivities,discoveryPeriods,scope,detail] of scopeCases){
    const run={...execution,discoveryPeriods,discoveryActivities};
    const elements=await runPage(async()=>({ok:true,async json(){return{availability:'Available',worker:'idle',latestExecution:run,executions:[run]}}}));
    assert.match(elements.history.innerHTML,new RegExp(`<span class="scope">${scope.replace(/[+]/g,'\\+')}<\\/span>`));
    assert.ok(elements.history.innerHTML.includes(detail));
    const details=elements.history.innerHTML.match(/<div class="detail-strip">([\s\S]*?)<\/div><\/details>/)[1];
    assert.doesNotMatch(details,/2602|2601/);
  }
});

test('Refresh supports empty history and can be repeated', async () => {
  let calls = 0;
  const elements = await runPage(async () => { calls++; return { ok: true, async json() { return { availability: 'Available', worker: 'idle', latestExecution: null, executions: [] }; } }; });
  assert.equal(elements.emptyLatest.hidden, false); assert.equal(elements.historyEmpty.hidden, false);
  await elements.refresh.listeners.click(); assert.equal(calls, 2);
});

test('successful zero-work latest execution omits redundant summary text and keeps concise history details', async () => {
  const zeroWork={...execution,status:'completed',associationsChecked:0,correctionsApplied:0,errors:0};
  const elements=await runPage(async()=>({ok:true,async json(){return {availability:'Available',worker:'idle',latestExecution:zeroWork,executions:[zeroWork]}}}));
  assert.equal(elements.latest.hidden,false); assert.equal(elements.latestDate.textContent.length>0,true);
  assert.equal(elements.outcome.textContent,'Completed');
  assert.equal(elements.latestMessage.textContent,'');
  assert.match(elements.history.innerHTML,/No work required · 2 min/);
  assert.doesNotMatch(elements.history.innerHTML,/Current \+ previous discovery/);
  assert.doesNotMatch(elements.history.innerHTML,/No associations needed processing\./);
  assert.doesNotMatch(elements.history.innerHTML,/Already compliant: 0/);
});

test('executions with work retain their summary counts', async () => {
  const worked={...execution,status:'completed',associationsChecked:3,correctionsApplied:2,errors:0};
  const elements=await runPage(async()=>({ok:true,async json(){return {availability:'Available',worker:'idle',latestExecution:worked,executions:[worked]}}}));
  assert.equal(elements.latestMessage.textContent,'Checked: 3 · Corrections: 2 · Errors: 0');
});

test('failed, cancelled, incomplete, and unknown outcomes never show successful no-work messaging', async () => {
  for (const status of ['failed','cancelled','pending',undefined]) {
    const nonSuccess={...execution,status,associationsChecked:0,correctionsApplied:0,errors:0};
    const elements=await runPage(async()=>({ok:true,async json(){return {availability:'Available',worker:'idle',latestExecution:nonSuccess,executions:[nonSuccess]}}}));
    assert.notEqual(elements.latestMessage.textContent,'No associations needed processing.',`zero-work message shown for ${status}`);
    assert.match(elements.latestMessage.textContent,/Checked: 0 · Corrections: 0 · Errors: 0/);
  }
});

test('Export History CSV keeps complete-history download, authorization, and brief success feedback', async () => {
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
  assert.equal(elements.timers.length,1);elements.timers[0]();assert.equal(elements.exportFeedback.textContent,'');
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
  assert.match(res.chunks[0], /Execution ID.*Execution source.*Historical backlog remaining.*Coverage.*Discovery period identifiers.*Discovery activities/);
  assert.match(res.chunks[2], /"run,""2"/); assert.match(res.chunks[2], /"","","failed"/);
  assert.equal(csvCell('a,"b'), '"a,""b"'); assert.equal(csvCell(undefined), '""');
});

test('audit CSV endpoint is authenticated, execution-scoped, empty-report safe, and formula-safe', async () => {
  const routes = {};
  const provider = { app: { get(path, handler) { routes[path] = handler; } }, onConnect() {} };
  registerSectionAssociationLtiInterface(provider, { deploymentId: 'deployment-1', getStatus: async()=>({}),
    getAuditAvailability: async id => id === '12345678-1234-1234-1234-123456789abc',
    async *getExecutionAudit() {} });
  const res = response(); res.locals.token = { deploymentId: 'deployment-1' };
  await routes['/api/section-association/corrections.csv']({ query: { executionId: '12345678-1234-1234-1234-123456789abc' } }, res);
  assert.equal(res.ended, true); assert.equal(res.chunks.length, 1);
  assert.match(res.chunks[0], /Execution ID.*Verified isActive.*Result/);
  assert.equal(auditCsvCell('=SUM(A1:A2)'), "\"'=SUM(A1:A2)\"");
  assert.equal(auditCsvCell('a,"b'), '"a,""b"');
  const denied = response(); denied.locals.token = { deploymentId: 'other' };
  await routes['/api/section-association/exceptions.csv']({ query: { executionId: '12345678-1234-1234-1234-123456789abc' } }, denied);
  assert.equal(denied.statusCode, 403); assert.equal(denied.chunks.length, 0);
});

test('Reports dropdown is available for audited zero-result runs and keyboard dismissal restores focus', async () => {
  const zeroAudited={...execution,executionId:'12345678-1234-1234-1234-123456789abc',detailedAuditAvailable:true,
    status:'completed',associationsChecked:0,correctionsApplied:0,errors:0};
  let request;
  const elements=await runPage(async(...args)=>{request=args;if(args[0].includes('/corrections.csv?'))return{ok:true,async blob(){return{}},headers:{get(){return'attachment; filename="report.csv"'}}};return{ok:true,async json(){return{availability:'Available',worker:'idle',latestExecution:zeroAudited,executions:[zeroAudited]}}}});
  assert.match(elements.history.innerHTML,/<summary aria-label="Reports for this execution">Reports<\/summary>/);
  assert.match(elements.history.innerHTML,/Corrections CSV/);assert.match(elements.history.innerHTML,/Exceptions CSV/);
  assert.match(elements.history.innerHTML,/quiet-work/);
  await elements.history.listeners.click({target:{closest(selector){return selector==='[data-audit]'?{dataset:{audit:'corrections',execution:zeroAudited.executionId},closest(sel){return sel==='.reports-menu'?elements.reportMenu:elements.reportEntry}}:null}}});
  assert.equal(request[0],'/api/section-association/corrections.csv?executionId='+zeroAudited.executionId);
  assert.equal(request[1].headers.Authorization,'Bearer signed-lti-token');assert.equal(request[1].credentials,'same-origin');
  assert.equal(elements.reportMenu.open,false);assert.equal(elements.reportSummary.focused,true);
  elements.reportMenu.open=true;elements.documentListeners.keydown({key:'Escape',stopPropagation(){}});
  assert.equal(elements.reportMenu.open,false);assert.equal(elements.reportSummary.focused,true);
  elements.reportMenu.open=true;elements.documentListeners.click({target:{closest(){return null}}});
  assert.equal(elements.reportMenu.open,false);
});

test('executions without detailed audit coverage show the unavailable note and no Reports dropdown', async()=>{
  const elements=await runPage(async()=>({ok:true,async json(){return{availability:'Available',worker:'idle',latestExecution:execution,executions:[execution]}}}));
  assert.match(elements.history.innerHTML,/Detailed reports unavailable\./);
  assert.doesNotMatch(elements.history.innerHTML,/<summary aria-label="Reports for this execution">/);
});

test('failed and incomplete executions show available duration and explanations, never no-work wording',async()=>{
  for(const status of ['failed','cancelled','pending']){
    const run={...execution,status,associationsChecked:0,errors:1,error:'Validation was blocked'};
    const elements=await runPage(async()=>({ok:true,async json(){return{availability:'Available',worker:'idle',latestExecution:run,executions:[run]}}}));
    assert.match(elements.history.innerHTML,/2 min/);assert.match(elements.history.innerHTML,/Validation was blocked/);
    assert.doesNotMatch(elements.history.innerHTML,/No work required/);
    assert.equal(elements.latestMessage.textContent,'Validation was blocked');
  }
});

test('missing timestamps and optional counts are omitted instead of invented',async()=>{
  const run={executionId:'run-missing',source:'automatic',status:'completed',associationsChecked:2,errors:0};
  const elements=await runPage(async()=>({ok:true,async json(){return{availability:'Available',worker:'idle',latestExecution:run,executions:[run]}}}));
  const details=elements.history.innerHTML.match(/<div class="detail-strip">([\s\S]*?)<\/div><\/details>/)[1];
  assert.equal(details,'<span class="execution-info"></span><span class="audit-unavailable">Detailed reports unavailable.</span>');
});

function responsiveStyles(){return pageForLaunch('token').match(/<style>([\s\S]*?)<\/style>/)[1]}

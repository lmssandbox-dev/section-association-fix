'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSectionAssociationClient } = require('../src/sectionAssociations/client');
const { createSectionAssociationService, academicPeriods, discoveryScope, isReverificationWindow, isRegularOperationsWindow,
  isHistoricalDiscoveryWindow, fullDiscoveryDue } = require('../src/sectionAssociations/service');

test('academic periods use Sao Paulo local date, semester convention, and year rollover', () => {
  assert.deepEqual(academicPeriods(Date.parse('2026-10-18T15:00:00Z')), { mode:'auto', previous:'2601', current:'2602', next:'2701', periods:['2601','2602','2701'] });
  assert.deepEqual(academicPeriods(Date.parse('2027-01-01T02:30:00Z')), { mode:'auto', previous:'2601', current:'2602', next:'2701', periods:['2601','2602','2701'] });
  assert.deepEqual(academicPeriods(Date.parse('2027-01-01T03:30:00Z')), { mode:'auto', previous:'2602', current:'2701', next:'2702', periods:['2602','2701','2702'] });
  assert.deepEqual(academicPeriods(Date.parse('2026-06-30T23:30:00Z')), { mode:'auto', previous:'2502', current:'2601', next:'2602', periods:['2502','2601','2602'] });
  assert.deepEqual(academicPeriods(Date.parse('2026-07-01T03:00:00Z')), { mode:'auto', previous:'2601', current:'2602', next:'2701', periods:['2601','2602','2701'] });
  assert.deepEqual(discoveryScope({mode:'explicit',periods:['2601']},Date.now()),{mode:'explicit',periods:['2601']});
  assert.deepEqual(discoveryScope({mode:'all',periods:[]},Date.now()),{mode:'all',periods:[]});
});

test('operating windows use Sao Paulo boundaries and the nightly window crosses midnight once', () => {
  assert.equal(isReverificationWindow(Date.parse('2026-10-18T03:59:00Z')), false); // 00:59
  assert.equal(isReverificationWindow(Date.parse('2026-10-18T04:00:00Z')), true); // 01:00
  assert.equal(isReverificationWindow(Date.parse('2026-10-18T04:15:00Z')), false); // 01:15
  assert.equal(isReverificationWindow(Date.parse('2026-10-18T04:30:00Z')), true); // 01:30
  assert.equal(isReverificationWindow(Date.parse('2026-10-18T09:30:00Z')), true); // 06:30
  assert.equal(isReverificationWindow(Date.parse('2026-10-18T10:00:00Z')), false); // 07:00
  assert.equal(isRegularOperationsWindow(Date.parse('2026-10-18T09:59:00Z')), false); // 06:59
  assert.equal(isRegularOperationsWindow(Date.parse('2026-10-18T10:00:00Z')), true); // 07:00
  assert.equal(isRegularOperationsWindow(Date.parse('2026-10-19T01:59:00Z')), true); // 22:59
  assert.equal(isRegularOperationsWindow(Date.parse('2026-10-19T02:00:00Z')), false); // 23:00
  assert.equal(isHistoricalDiscoveryWindow(Date.parse('2026-10-19T02:00:00Z')), true); // 23:00
  assert.equal(isHistoricalDiscoveryWindow(Date.parse('2026-10-19T02:45:00Z')), true); // 23:45
  assert.equal(isHistoricalDiscoveryWindow(Date.parse('2026-10-19T03:00:00Z')), true); // 00:00
  assert.equal(isHistoricalDiscoveryWindow(Date.parse('2026-10-19T03:45:00Z')), true); // 00:45
  assert.equal(isHistoricalDiscoveryWindow(Date.parse('2026-10-19T04:00:00Z')), false); // 01:00
  assert.equal(fullDiscoveryDue(new Date('2026-10-19T02:00:00Z'), Date.parse('2026-10-19T03:45:00Z')), false);
  assert.equal(fullDiscoveryDue(new Date('2026-10-19T03:15:00Z'), Date.parse('2026-10-19T03:45:00Z')), false);
  assert.equal(fullDiscoveryDue(new Date('2026-10-19T03:15:00Z'), Date.parse('2026-10-20T02:00:00Z')), true);
  assert.equal(fullDiscoveryDue(null, Date.parse('2026-10-19T01:59:00Z')), false);
  assert.equal(fullDiscoveryDue(null, Date.parse('2026-10-19T02:00:00Z')), true);
  for (let hour = 1; hour <= 6; hour++) {
    for (const minute of [0, 15, 30, 45]) {
      const instant = Date.parse(`2026-10-18T${String(hour + 3).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`);
      assert.equal(isReverificationWindow(instant), minute === 0 || minute === 30, `${hour}:${minute}`);
    }
  }
  assert.equal(isReverificationWindow(Date.parse('2026-10-18T03:00:00Z')), false); // before 01:00
  assert.equal(isReverificationWindow(Date.parse('2026-10-18T10:00:00Z')), false); // at 07:00
});

test('Brightspace discovery accepts both broad and period-specific code-family queries and paginates each', async () => {
  const requested = [];
  const client = createSectionAssociationClient({ baseUrl: 'https://tenant.example', lpVersion: '1.60', oauth: {}, http: async () => {},
    get: async url => { requested.push(url); return { Items: [], PagingInfo: { HasMoreItems: false } }; } });
  await client.associationCandidates('2602-I0001');
  await client.associationCandidates('2601-I0001');
  await client.associationCandidates('I0001');
  await client.associationCandidates('ESPM-2602-');
  await client.associationCandidates('ESPM-');
  assert.deepEqual(requested.map(url => new URL(url).searchParams.get('orgUnitCode')),
    ['2602-I0001', '2601-I0001', 'I0001', 'ESPM-2602-', 'ESPM-']);
  assert.throws(() => client.associationCandidates('history-I0001'), /Invalid Section Association discovery code/);
  assert.throws(() => client.associationCandidates('ESPM-2603-'), /Invalid Section Association discovery code/);
});

function makeService({ time, failFull = false, duplicateAcrossQueries = false, discoveryConfiguration = {mode:'auto',periods:[]} } = {}) {
  const calls = [];
  const persisted = [];
  let fullAt = null;
  const association = { Identifier: 7, Code: '002521-01-2602-I0001', Type: { Code: 'Course Offering' } };
  const store = {
    async baselineStatus() { return { state: 'ready' }; },
    async lastFullDiscoveryAt() { return fullAt; },
    async markFullDiscoveryCompleted() { fullAt = new Date(time); },
    async recordDiscoveries(records) { persisted.push(...records); return { newlyRecorded: 0, alreadyKnown: records.length }; },
    async countHistoricalBacklog() { return 0; }, async listWaitingNew() { return []; },
    async listFastWork(options) { calls.push(['work', options.includeCompletedReverification]); return []; }
  };
  const client = { async associationCandidates(code) {
    calls.push(['query', code]);
    if (code === 'I0001' && failFull) throw new Error('full scan failure');
    return code === 'I0001' || code === 'ESPM-' || duplicateAcrossQueries ? [association] : [];
  } };
  const service = createSectionAssociationService({ client, store, reconciler: {}, discoveryConfiguration, now: () => time, logger: { info() {}, warn() {}, error() {} } });
  return { service, calls, store, persisted, get fullAt() { return fullAt; } };
}

test('broad discovery runs once across 23:00–01:00 and period discovery resumes the next morning', async () => {
  const time = Date.parse('2026-10-19T02:15:00Z'); // 23:15 local
  const h = makeService({ time });
  const first = await h.service.fastTick();
  assert.equal(first.status, 'completed');
  assert.deepEqual(first.discoveryActivities, { historical:true });
  assert.ok(h.fullAt instanceof Date);
  assert.deepEqual(h.calls.filter(([kind]) => kind === 'query').map(([, code]) => code), ['I0001', 'ESPM-']);
  h.calls.length = 0;
  h.service = createSectionAssociationService({ client: { async associationCandidates(code) { h.calls.push(['query', code]); return []; } },
    store: { async baselineStatus() { return { state:'ready' }; }, async lastFullDiscoveryAt() { return h.fullAt; },
      async recordDiscoveries() { return { newlyRecorded:0, alreadyKnown:0 }; }, async countHistoricalBacklog() { return 0; },
      async listWaitingNew() { return []; }, async listFastWork() { return []; } }, reconciler: {},
    now: () => Date.parse('2026-10-19T10:15:00Z'), logger: {info(){},warn(){},error(){}} });
  assert.equal((await h.service.fastTick()).status, 'completed');
  assert.deepEqual(h.calls.filter(([kind]) => kind === 'query').map(([, code]) => code), ['2601-I0001', 'ESPM-2601-', '2602-I0001', 'ESPM-2602-', '2701-I0001', 'ESPM-2701-']);
});

test('failed full discovery retries after midnight within the same nightly window', async () => {
  let time = Date.parse('2026-10-19T02:45:00Z'); // 23:45
  let fullAt = null, failLegacy = true;
  const queries = [];
  const store = { async baselineStatus() { return { state: 'ready' }; }, async lastFullDiscoveryAt() { return fullAt; },
    async markFullDiscoveryCompleted() { fullAt = new Date(time); }, async recordDiscoveries() { return { newlyRecorded: 0, alreadyKnown: 0 }; },
    async countHistoricalBacklog() { return 0; }, async listWaitingNew() { return []; }, async listFastWork() { return []; } };
  const client = { async associationCandidates(code) { queries.push(code); if (code === 'I0001' && failLegacy) throw new Error('temporary scan failure'); return []; } };
  const service = createSectionAssociationService({ client, store, reconciler: {}, now: () => time,
    logger: { info() {}, warn() {}, error() {} } });
  assert.equal((await service.fastTick()).status, 'completed');
  assert.equal(fullAt, null);
  time = Date.parse('2026-10-20T03:15:00Z'); // 00:15 in the same nightly window
  failLegacy = false;
  assert.equal((await service.fastTick()).status, 'completed');
  assert.ok(fullAt instanceof Date);
  assert.deepEqual(queries, ['I0001', 'I0001', 'ESPM-']);
});

test('successful broad discovery at 23:00 does not repeat after midnight in the same nightly window', async () => {
  let time = Date.parse('2026-10-19T02:00:00Z'); // 23:00
  let fullAt = null;
  const queries = [];
  const store = { async baselineStatus() { return { state: 'ready' }; }, async lastFullDiscoveryAt() { return fullAt; },
    async markFullDiscoveryCompleted() { fullAt = new Date(time); }, async recordDiscoveries() { return { newlyRecorded: 0, alreadyKnown: 0 }; },
    async countHistoricalBacklog() { return 0; }, async listWaitingNew() { return []; }, async listFastWork() { return []; } };
  const client = { async associationCandidates(code) { queries.push(code); return []; } };
  const service = createSectionAssociationService({ client, store, reconciler: {}, now: () => time,
    logger: { info() {}, warn() {}, error() {} } });
  await service.fastTick();
  assert.deepEqual(queries, ['I0001', 'ESPM-']);
  time = Date.parse('2026-10-19T03:15:00Z'); // 00:15 same logical window
  await service.fastTick();
  assert.deepEqual(queries, ['I0001', 'ESPM-']);
});

test('historical discovery does not run period queries outside their daytime window', async () => {
  const time=Date.parse('2026-10-19T02:15:00Z');
  const calls=[];
  const store={async baselineStatus(){return {state:'ready'}},async lastFullDiscoveryAt(){return null},
    async markFullDiscoveryCompleted(){},async recordDiscoveries(){return {newlyRecorded:0,alreadyKnown:0}},
    async countHistoricalBacklog(){return 0},async listWaitingNew(){return []},async listFastWork(){return []}};
  const client={async associationCandidates(code){calls.push(code);return []}};
  const service=createSectionAssociationService({client,store,reconciler:{},now:()=>time,logger:{info(){},warn(){},error(){}}});
  const result=await service.fastTick();
  assert.equal(result.status,'completed');
  assert.equal(result.discoveryPeriods,undefined);
  assert.deepEqual(result.discoveryActivities,{historical:true});
  assert.deepEqual(calls,['I0001','ESPM-']);
});

test('re-verification is recorded only when a re-verification work item is processed', async()=>{
  const time=Date.parse('2026-10-18T06:15:00Z');
  const store={async baselineStatus(){return {state:'ready'}},async lastFullDiscoveryAt(){return new Date(time)},
    async recordDiscoveries(){return {newlyRecorded:0,alreadyKnown:0}},async countHistoricalBacklog(){return 0},
    async listWaitingNew(){return []},async listFastWork(){return [{workType:'reverify',associationOrgUnitId:'7',associationCode:'002521-01-2602-I0001'}]}};
  const client={async associationCandidates(){return []}};
  const reconciler={async reconcileAssociation(){return {status:'completed',targets:[{status:'already-inactive'}]}}};
  const service=createSectionAssociationService({client,store,reconciler,now:()=>time,logger:{info(){},warn(){},error(){}}});
  const result=await service.fastTick();
  assert.equal(result.status,'completed');
  assert.deepEqual(result.discoveryActivities,{reverification:true});
});

test('explicit discovery queries configured periods and all mode reuses one broad query', async () => {
  const explicit=makeService({time:Date.parse('2026-10-18T15:00:00Z'),discoveryConfiguration:{mode:'explicit',periods:['2601','2701']}});
  const explicitResult=await explicit.service.fastTick();
  assert.deepEqual(explicitResult.discoveryPeriods,{mode:'explicit',periods:['2601','2701']});
  assert.deepEqual(explicit.calls.filter(([kind])=>kind==='query').map(([,code])=>code),['2601-I0001','ESPM-2601-','2701-I0001','ESPM-2701-']);
  const all=makeService({time:Date.parse('2026-10-19T02:15:00Z'),discoveryConfiguration:{mode:'all',periods:[]}});
  const allResult=await all.service.fastTick();
  assert.deepEqual(allResult.discoveryPeriods,{mode:'all',periods:[]});
  assert.deepEqual(all.calls.filter(([kind])=>kind==='query').map(([,code])=>code),['I0001','ESPM-']);
  assert.ok(all.fullAt instanceof Date);
});

test('valid association IDs are deduplicated across broad and period searches before persistence', async () => {
  const h=makeService({time:Date.parse('2026-10-18T15:00:00Z'),duplicateAcrossQueries:true,
    discoveryConfiguration:{mode:'explicit',periods:['2601','2602']}});
  const result=await h.service.fastTick();
  assert.equal(result.discovered,1);
  assert.equal(h.persisted.filter(record=>String(record.id)==='7').length,1);
});

test('legacy and PeopleSoft candidates are both discovered and deduplicated by Brightspace ID', async () => {
  const time=Date.parse('2026-10-18T15:00:00Z');
  const legacy={Identifier:41,Code:'002521-01-2602-I0001',Type:{Code:'Course Offering'}};
  const modern={Identifier:42,Code:'ESPM-2602-GS2-C0011',Type:{Code:'Course Offering'}};
  const persisted=[];
  const store={async baselineStatus(){return {state:'ready'}},async lastFullDiscoveryAt(){return new Date(time)},
    async recordDiscoveries(records){persisted.push(...records);return {newlyRecorded:records.length,alreadyKnown:0}},
    async countHistoricalBacklog(){return 0},async listWaitingNew(){return []},async listFastWork(){return []}};
  const client={async associationCandidates(code){return code==='2602-I0001'?[legacy]:code==='ESPM-2602-'?[modern,{...legacy}]:[]}};
  const service=createSectionAssociationService({client,store,reconciler:{},discoveryConfiguration:{mode:'explicit',periods:['2602']},now:()=>time,logger:{info(){},warn(){},error(){}}});
  const result=await service.fastTick();
  assert.equal(result.discovered,2);
  assert.deepEqual(persisted.map(row=>String(row.id)).sort(),['41','42']);
});

test('initial historical baseline waits for the broad discovery window', async () => {
  const time=Date.parse('2026-10-19T02:00:00Z'); const calls=[]; let baselineRecords=[];
  const legacy={Identifier:61,Code:'002521-01-2602-I0001',Type:{Code:'Course Offering'}};
  const modern={Identifier:62,Code:'ESPM-2602-GS2-C0011',Type:{Code:'Course Offering'}};
  const store={async baselineStatus(){return {state:'pending'}},async lastFullDiscoveryAt(){return null},
    async beginBaseline(){return 'lease'},async finishBaseline(token,records){baselineRecords=records;return {newlyRecorded:records.length,alreadyKnown:0}},
    async recordDiscoveries(){return {newlyRecorded:0,alreadyKnown:0}},async markFullDiscoveryCompleted(){},
    async countHistoricalBacklog(){return 0},async listWaitingNew(){return []},async listFastWork(){return []}};
  const client={async associationCandidates(code){calls.push(code);return code==='I0001'?[legacy]:code==='ESPM-'?[modern]:[]}};
  const service=createSectionAssociationService({client,store,reconciler:{},discoveryConfiguration:{mode:'explicit',periods:['2602']},now:()=>time,logger:{info(){},warn(){},error(){}}});
  const result=await service.fastTick();
  assert.equal(result.status,'completed');
  assert.deepEqual(calls,['I0001','ESPM-']);
  assert.deepEqual(baselineRecords.map(row=>String(row.id)).sort(),['61','62']);
});

test('regular discovery continues during the first day while the broad baseline is pending', async()=>{
  const time=Date.parse('2026-10-18T15:00:00Z'),queries=[],persisted=[];
  const association={Identifier:71,Code:'002521-01-2602-I0001',Type:{Code:'Course Offering'}};
  const store={async baselineStatus(){return {state:'pending'}},async lastFullDiscoveryAt(){return null},
    async recordDiscoveries(rows){persisted.push(...rows);return {newlyRecorded:rows.length,alreadyKnown:0}},
    async countHistoricalBacklog(){return 0},async listWaitingNew(){return []},async listFastWork(){return []}};
  const client={async associationCandidates(code){queries.push(code);return [association]}};
  const service=createSectionAssociationService({client,store,reconciler:{},discoveryConfiguration:{mode:'explicit',periods:['2602']},
    now:()=>time,logger:{info(){},warn(){},error(){}}});
  const result=await service.fastTick();
  assert.equal(result.status,'completed');
  assert.deepEqual(queries,['2602-I0001','ESPM-2602-']);
  assert.deepEqual(persisted.map(row=>String(row.id)),['71']);
});

test('explicit old periods remain discoverable but are excluded from ongoing monitoring', async()=>{
  const time=Date.parse('2026-10-18T15:00:00Z');let monitoredPeriods;
  const store={async baselineStatus(){return {state:'ready'}},async lastFullDiscoveryAt(){return new Date(time)},
    async recordDiscoveries(){return {newlyRecorded:0,alreadyKnown:0}},async countHistoricalBacklog(){return 0},
    async listWaitingNew(){return []},async listFastWork(){return []},async listMonitoringWork({periods}){monitoredPeriods=periods;return []},
    async countDueMonitoring(){return 0}};
  const client={async associationCandidates(){return []}};
  const service=createSectionAssociationService({client,store,reconciler:{},discoveryConfiguration:{mode:'explicit',periods:['2501','2602']},
    now:()=>time,logger:{info(){},warn(){},error(){}}});
  await service.fastTick();
  assert.deepEqual(monitoredPeriods,['2602']);
});

test('completed full re-verification is no longer selected by the legacy work path', async () => {
  const outside = makeService({ time: Date.parse('2026-10-18T09:15:00Z') });
  await outside.service.fastTick();
  assert.equal(outside.calls.find(([kind]) => kind === 'work')[1], false);
  const inside = makeService({ time: Date.parse('2026-10-18T06:15:00Z') });
  await inside.service.fastTick();
  assert.equal(inside.calls.find(([kind]) => kind === 'work')[1], false);
});

test('daytime child monitoring ignores response order and routes changed snapshots through full reconciliation', async () => {
  const time = Date.parse('2026-10-18T15:15:00Z');
  const saved = [{ id:'12', code:'002521-01-2602-GS2-EL1S-00001' }, { id:'13', code:'002521-01-2602-GS2-EL1T-00002' }];
  let calls = 0; const writes = [];
  const store = { async baselineStatus(){return {state:'ready'}}, async lastFullDiscoveryAt(){return new Date(time)},
    async recordDiscoveries(){return {newlyRecorded:0,alreadyKnown:0}}, async countHistoricalBacklog(){return 0},
    async listWaitingNew(){return []}, async listFastWork(){return []},
    async listMonitoringWork({kind}) { return kind==='children' ? [{associationOrgUnitId:'7', associationCode:'002521-01-2602-I0001',
      verifiedMappingVersion:1, verifiedChildren:saved, verifiedTargets:[{id:'90',code:'002521-01-2602-GS2-EL1S'},{id:'91',code:'002521-01-2602-GS2-EL1T'}],
      verifiedMappings:saved.map((child,index)=>({sectionId:child.id,sectionCode:child.code,targetId:index?'91':'90',targetCode:index?'002521-01-2602-GS2-EL1T':'002521-01-2602-GS2-EL1S'}))}] : []; },
    async record(id, fields){writes.push(fields)}, async countDueMonitoring(){return 0} };
  const client = { async associationCandidates(){return []}, async children(){return [...saved].reverse().map(row=>({...row,Type:{Code:'Group'}}))} };
  const reconciler = { async reconcileAssociation(){calls++;return {status:'completed',targets:[{status:'already-inactive'}]}} };
  const service = createSectionAssociationService({client,store,reconciler,now:()=>time,logger:{info(){},warn(){},error(){}}});
  const unchanged = await service.fastTick();
  assert.equal(calls,0);
  assert.equal(unchanged.childChecksSucceeded,1);
  assert.equal(unchanged.childChangesDetected,0);
  assert.equal(unchanged.childMappingRefreshesRequired,0);
  assert.ok(writes.some(row=>row.lastSuccessfulChildInspectionAt instanceof Date));
  client.children = async()=>[...saved,{id:'14',code:'002521-01-2602-GS2-EL1U-00003'}].map(row=>({...row,Type:{Code:'Group'}}));
  const changed = await service.fastTick();
  assert.equal(calls,1);
  assert.equal(changed.childChangesDetected,1);
  assert.equal(changed.childMappingRefreshesRequired,1);
});

function childDiagnosticFixture({ debugAssociationId, ids = ['36183'], savedById = {}, currentById = {}, limit = 50 } = {}) {
  const time = Date.parse('2026-11-06T15:15:00Z');
  const calls = { children: [], reconciliations: [], records: [] };
  const mappings = id => {
    const children = savedById[id] || [{ id: '36187', code: '012263-01-2601-POS-S51H-01125' }];
    return { verifiedMappingVersion: 1, verifiedChildren: children,
      verifiedTargets: children.map((child, index) => ({ id: String(90000 + index), code: child.code.slice(0, -6) })),
      verifiedMappings: children.map((child, index) => ({ sectionId: child.id, sectionCode: child.code,
        targetId: String(90000 + index), targetCode: child.code.slice(0, -6) })) };
  };
  const items = ids.map(id => ({ associationOrgUnitId: id, associationCode: '012263-01-2601-I0001', ...mappings(id) }));
  const store = { async baselineStatus() { return { state: 'ready' }; }, async lastFullDiscoveryAt() { return new Date(time); },
    async recordDiscoveries() { return { newlyRecorded: 0, alreadyKnown: 0 }; }, async countHistoricalBacklog() { return 0; },
    async listWaitingNew() { return []; }, async listFastWork() { return []; },
    async listMonitoringWork({ kind }) { return kind === 'children' ? items : []; },
    async record(id, fields) { calls.records.push({ id, fields }); }, async countDueMonitoring() { return 0; } };
  const defaultChildren = id => savedById[id] || [{ id: '36187', code: '012263-01-2601-POS-S51H-01125' }];
  const client = { async associationCandidates() { return []; }, async children(id) {
    calls.children.push(id);
    return (currentById[id] || defaultChildren(id)).map(row => ({ Identifier: row.id, Code: row.code,
      Type: { Code: row.type || 'Group' } }));
  } };
  const reconciler = { async reconcileAssociation(id) {
    calls.reconciliations.push(id);
    return { status: 'completed', targets: [{ status: 'already-inactive' }] };
  } };
  const lines = [];
  const service = createSectionAssociationService({ client, store, reconciler, maxReconciliationsPerRun: limit,
    childMonitoringBatchSize: ids.length, debugAssociationId,
    now: () => time, logger: { info(line) { lines.push(line); }, warn() {}, error() {} } });
  return { service, calls, lines };
}

test('targeted child diagnostics are disabled by default and unchanged children do not reconcile', async () => {
  const h = childDiagnosticFixture();
  const result = await h.service.fastTick();
  assert.equal(h.lines.some(line => line.includes('child monitoring diagnostic')), false);
  assert.deepEqual(h.calls.children, ['36183']);
  assert.deepEqual(h.calls.reconciliations, []);
  assert.equal(result.childChecksSucceeded, 1);
  assert.equal(result.childChangesDetected, 0);
});

test('sample child diagnostics log only the first inspected association once per execution', async () => {
  const h = childDiagnosticFixture({ ids: ['36183', '36184', '36185'], debugAssociationId: 'sample' });
  const execution = {};
  const first = await h.service.fastTick({ execution });
  let diagnostics = h.lines.filter(line => line.includes('child monitoring diagnostic'));
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0], /associationId=36183/);
  assert.match(diagnostics[0], /mappingTrusted=true/);
  assert.match(diagnostics[0], /savedCurrentChildrenMatch=true/);
  assert.match(diagnostics[0], /normalizedListsMatch=true/);
  assert.match(diagnostics[0], /reconciliationRequested=false/);
  assert.match(diagnostics[0], /reconciliationReason=none/);
  assert.deepEqual(h.calls.children, ['36183', '36184', '36185']);
  assert.deepEqual(h.calls.reconciliations, []);
  assert.equal(first.childChangesDetected, 0);

  await h.service.fastTick({ execution });
  diagnostics = h.lines.filter(line => line.includes('child monitoring diagnostic'));
  assert.equal(diagnostics.length, 1);
  await h.service.fastTick({ execution: {} });
  diagnostics = h.lines.filter(line => line.includes('child monitoring diagnostic'));
  assert.equal(diagnostics.length, 2);
  assert.match(diagnostics[1], /associationId=36183/);
});

test('targeted child diagnostics report matching saved/current rows without reconciliation', async () => {
  const h = childDiagnosticFixture({ ids: ['36183', '36184'], debugAssociationId: '36183' });
  const result = await h.service.fastTick();
  const diagnostics = h.lines.filter(line => line.includes('child monitoring diagnostic'));
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0], /associationId=36183/);
  assert.match(diagnostics[0], /mappingTrusted=true/);
  assert.match(diagnostics[0], /savedChildren=\[\{"id":"36187","code":"012263-01-2601-POS-S51H-01125"\}\]/);
  assert.match(diagnostics[0], /currentChildren=\[\{"id":"36187","code":"012263-01-2601-POS-S51H-01125","type":"Group"\}\]/);
  assert.match(diagnostics[0], /savedCurrentChildrenMatch=true/);
  assert.match(diagnostics[0], /normalizedListsMatch=true/);
  assert.match(diagnostics[0], /unexpectedChildType=false/);
  assert.match(diagnostics[0], /reconciliationRequested=false/);
  assert.match(diagnostics[0], /reconciliationReason=none/);
  assert.match(diagnostics[0], /successfulInspectionTimestampUpdated=true/);
  assert.equal(result.childChangesDetected, 0);
  assert.equal(h.calls.children.length, 2);
  assert.deepEqual(h.calls.reconciliations, []);
});

test('association 37003 matches its three saved snapshot rows to API-shaped child rows', async () => {
  const saved = [
    { id: '37004', code: '012263-01-2601-POS-S51H-01125' },
    { id: '37005', code: '012263-01-2601-POS-S52H-01139' },
    { id: '37006', code: '012263-01-2601-POS-S53H-01140' }
  ];
  const h = childDiagnosticFixture({ ids: ['37003'], debugAssociationId: '37003', savedById: { '37003': saved },
    currentById: { '37003': [...saved].reverse() } });
  const result = await h.service.fastTick();
  const line = h.lines.find(row => row.includes('child monitoring diagnostic'));
  assert.match(line, /associationId=37003/);
  assert.match(line, /mappingTrusted=true/);
  assert.match(line, /savedCurrentChildrenMatch=true/);
  assert.match(line, /normalizedListsMatch=true/);
  assert.match(line, /unexpectedChildType=false/);
  assert.match(line, /reconciliationRequested=false/);
  assert.match(line, /successfulInspectionTimestampUpdated=true/);
  assert.equal(result.childChecksSucceeded, 1);
  assert.equal(result.childChangesDetected, 0);
  assert.deepEqual(h.calls.children, ['37003']);
  assert.deepEqual(h.calls.reconciliations, []);
});

test('targeted child diagnostics report changed rows and their reconciliation reason', async () => {
  const h = childDiagnosticFixture({ debugAssociationId: '36183', currentById: {
    '36183': [{ id: '36187', code: '012263-01-2601-POS-S51H-01125' },
      { id: '36190', code: '012263-01-2601-POS-S52H-01139' }]
  } });
  const result = await h.service.fastTick();
  const line = h.lines.find(row => row.includes('child monitoring diagnostic'));
  assert.match(line, /normalizedListsMatch=false/);
  assert.match(line, /reconciliationRequested=true/);
  assert.match(line, /reconciliationReason=child-list-difference/);
  assert.match(line, /reconciliationDisposition=scheduled/);
  assert.match(line, /successfulInspectionTimestampUpdated=true/);
  assert.equal(result.childChangesDetected, 1);
  assert.deepEqual(h.calls.reconciliations, ['36183']);
});

test('child removals and Org Code changes still request full reconciliation', async t => {
  const saved = [
    { id: '36187', code: '012263-01-2601-POS-S51H-01125' },
    { id: '36190', code: '012263-01-2601-POS-S52H-01139' }
  ];
  const cases = [
    { name: 'removal', current: [saved[0]] },
    { name: 'code change', current: [saved[0], { ...saved[1], code: '012263-01-2601-POS-S52H-01141' }] }
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const h = childDiagnosticFixture({ debugAssociationId: '36183', savedById: { '36183': saved },
        currentById: { '36183': scenario.current } });
      const result = await h.service.fastTick();
      const line = h.lines.find(row => row.includes('child monitoring diagnostic'));
      assert.match(line, /savedCurrentChildrenMatch=false/);
      assert.match(line, /normalizedListsMatch=false/);
      assert.match(line, /reconciliationRequested=true/);
      assert.match(line, /reconciliationReason=child-list-difference/);
      assert.equal(result.childChangesDetected, 1);
      assert.deepEqual(h.calls.reconciliations, ['36183']);
    });
  }
});

test('targeted child diagnostics report unexpected child types independently of list equality', async () => {
  const h = childDiagnosticFixture({ debugAssociationId: '36183', currentById: {
    '36183': [{ id: '36187', code: '012263-01-2601-POS-S51H-01125', type: 'Course Offering' }]
  } });
  await h.service.fastTick();
  const line = h.lines.find(row => row.includes('child monitoring diagnostic'));
  assert.match(line, /currentChildTypes=\["Course Offering"\]/);
  assert.match(line, /unexpectedChildType=true/);
  assert.match(line, /normalizedListsMatch=true/);
  assert.match(line, /reconciliationReason=unexpected-child-type/);
  assert.match(line, /savedCurrentChildrenMatch=true/);
  assert.deepEqual(h.calls.children, ['36183']);
  assert.deepEqual(h.calls.reconciliations, ['36183']);
});

test('targeted child diagnostics explain invalid mappings without adding a Brightspace read', async () => {
  const invalid = childDiagnosticFixture({ debugAssociationId: '36183', savedById: { '36183': [] } });
  const result = await invalid.service.fastTick();
  const line = invalid.lines.find(row => row.includes('child monitoring diagnostic'));
  assert.match(line, /mappingTrusted=false/);
  assert.match(line, /mappingFailure=empty-children/);
  assert.match(line, /reconciliationReason=invalid-mapping/);
  assert.match(line, /reconciliationDisposition=scheduled/);
  assert.deepEqual(invalid.calls.children, []);
  assert.deepEqual(invalid.calls.reconciliations, ['36183']);
  assert.equal(result.childChecksAttempted, 0);
});

test('targeted child diagnostics report reconciliation deferred by the full-reconciliation cap', async () => {
  const h = childDiagnosticFixture({ ids: ['36183', '36184'], debugAssociationId: '36184', limit: 1,
    currentById: { '36183': [{ id: '36187', code: '012263-01-2601-POS-S51H-01125' },
      { id: '36190', code: '012263-01-2601-POS-S52H-01139' }],
    '36184': [{ id: '36187', code: '012263-01-2601-POS-S51H-01125' },
      { id: '36190', code: '012263-01-2601-POS-S52H-01139' }] } });
  const result = await h.service.fastTick();
  const line = h.lines.find(row => row.includes('child monitoring diagnostic'));
  assert.match(line, /associationId=36184/);
  assert.match(line, /reconciliationDisposition=deferred-capacity/);
  assert.match(line, /successfulInspectionTimestampUpdated=false/);
  assert.deepEqual(h.calls.reconciliations, ['36183']);
  assert.equal(result.childChangesDetected, 2);
  assert.equal(h.calls.children.length, 2);
});

test('night cached-ID verification is skipped at quarter-hour slots and runs at half-hour slots', async()=>{
  let time=Date.parse('2026-10-18T04:15:00Z'); let active=false, reconciles=0, statusQueries=0, statusLimit; const writes=[];
  const store={async baselineStatus(){return {state:'ready'}},async lastFullDiscoveryAt(){return new Date(time)},
    async recordDiscoveries(){return {newlyRecorded:0,alreadyKnown:0}},async countHistoricalBacklog(){return 0},
    async listWaitingNew(){return []},async listFastWork(){return []},
    async listMonitoringWork({kind,limit}){if(kind==='status'){statusQueries++;statusLimit=limit;}return kind==='status'?[{associationOrgUnitId:'7',associationCode:'002521-01-2602-I0001',
      verifiedMappingVersion:1,verifiedChildren:[{id:'12',code:'002521-01-2602-GS2-EL1S-00001'}],
      verifiedTargets:[{id:'90',code:'002521-01-2602-GS2-EL1S'}],verifiedMappings:[{sectionId:'12',sectionCode:'002521-01-2602-GS2-EL1S-00001',targetId:'90',targetCode:'002521-01-2602-GS2-EL1S'}]}]:[]},
    async record(id,fields){writes.push(fields)},async countDueMonitoring(){return 0}};
  const client={async associationCandidates(){return []},async course(){return {Identifier:90,Type:{Code:'Course Offering'},Code:'002521-01-2602-GS2-EL1S',IsActive:active}}};
  const reconciler={async reconcileAssociation(){reconciles++;return {status:'completed',targets:[{status:'already-inactive'}]}}};
  const service=createSectionAssociationService({client,store,reconciler,now:()=>time,logger:{info(){},warn(){},error(){}}});
  await service.fastTick();
  assert.equal(statusQueries,0);
  time=Date.parse('2026-10-18T04:30:00Z');
  const checked = await service.fastTick();
  assert.equal(statusQueries,1);
  assert.equal(statusLimit,150);
  assert.equal(reconciles,0);
  assert.equal(checked.statusChecksSucceeded,1);
  assert.equal(checked.statusChangesDetected,0);
  assert.ok(writes.some(row=>row.lastSuccessfulStatusVerificationAt instanceof Date));
  active=true; time=Date.parse('2026-10-18T05:00:00Z'); await service.fastTick(); assert.equal(reconciles,1);
});

test('pending work remains eligible at quarter-hour slots when cached-ID verification is skipped', async () => {
  const time = Date.parse('2026-10-18T04:15:00Z'); // 01:15 local
  let pendingProcessed = 0, statusQueries = 0;
  const store = { async baselineStatus() { return { state: 'ready' }; }, async lastFullDiscoveryAt() { return new Date(time); },
    async recordDiscoveries() { return { newlyRecorded: 0, alreadyKnown: 0 }; }, async countHistoricalBacklog() { return 0; },
    async listWaitingNew() { return []; }, async listFastWork() { return [{ associationOrgUnitId: '9', associationCode: 'pending' }]; },
    async listMonitoringWork() { statusQueries++; return []; } };
  const reconciler = { async reconcileAssociation() { pendingProcessed++; return { status: 'completed' }; } };
  const service = createSectionAssociationService({ client: { async associationCandidates() { return []; } }, store, reconciler,
    now: () => time, logger: { info() {}, warn() {}, error() {} } });
  await service.fastTick();
  assert.equal(pendingProcessed, 1);
  assert.equal(statusQueries, 0);
});

test('missing confirmation uses completed period results and exact IDs without extra API requests', async () => {
  const time = Date.parse('2026-10-20T12:00:00Z'); const calls = []; const confirmations = [];
  const store = { async baselineStatus() { return { state: 'ready' }; }, async lastFullDiscoveryAt() { return new Date(time); },
    async recordDiscoveries() { return { newlyRecorded: 0, alreadyKnown: 0 }; },
    async confirmMissing(input) { confirmations.push(input); return { confirmed: 0 }; },
    async countHistoricalBacklog() { return 0; }, async listWaitingNew() { return []; }, async listFastWork() { return []; } };
  const client = { async associationCandidates(code) { calls.push(code); return code === '2602-I0001'
    ? [{ Identifier: 48865, Code: 'not-a-valid-association-now', Type: { Code: 'Group' } }] : []; } };
  const service = createSectionAssociationService({ client, store, reconciler: {}, discoveryConfiguration: { mode: 'explicit', periods: ['2602'] },
    now: () => time, logger: { info() {}, warn() {}, error() {} } });
  const result = await service.fastTick({ execution: { executionId: 'period-evidence' } });
  assert.equal(result.status, 'completed');
  assert.deepEqual(calls, ['2602-I0001', 'ESPM-2602-']);
  assert.equal(confirmations.length, 2);
  assert.deepEqual(confirmations[0].periods, ['2602']);
  assert.deepEqual(confirmations[0].discoveredIds, ['48865']);
  assert.equal(confirmations[0].format, 'legacy');
  assert.equal(confirmations[1].format, 'peoplesoft');
  assert.equal(confirmations[0].discoveryAt.getTime(), time);
});

test('failed period discovery never supplies absence evidence', async () => {
  const time = Date.parse('2026-10-20T12:00:00Z'); const confirmations = [];
  const store = { async baselineStatus() { return { state: 'ready' }; }, async lastFullDiscoveryAt() { return new Date(time); },
    async recordDiscoveries() { return { newlyRecorded: 0, alreadyKnown: 0 }; }, async confirmMissing(input) { confirmations.push(input); },
    async countHistoricalBacklog() { return 0; }, async listWaitingNew() { return []; }, async listFastWork() { return []; } };
  const client = { async associationCandidates() { throw new Error('incomplete period scan'); } };
  const service = createSectionAssociationService({ client, store, reconciler: {}, discoveryConfiguration: { mode: 'explicit', periods: ['2602'] },
    now: () => time, logger: { info() {}, warn() {}, error() {} } });
  assert.equal((await service.fastTick()).status, 'failed');
  assert.equal(confirmations.length, 0);
});

test('fast and recovery phases do not reconcile one association twice in the same execution', async () => {
  const time = Date.parse('2026-10-20T12:00:00Z'); let reconciles = 0;
  const item = { associationOrgUnitId: '48865', associationCode: '002366-01-2602-I0001' };
  const store = { async baselineStatus() { return { state: 'ready' }; }, async lastFullDiscoveryAt() { return new Date(time); },
    async recordDiscoveries() { return { newlyRecorded: 0, alreadyKnown: 0 }; }, async confirmMissing() { return { confirmed: 0 }; },
    async countHistoricalBacklog() { return 0; }, async listWaitingNew() { return []; }, async listFastWork() { return [item]; },
    async listRecoveryWork() { return [item]; }, async countRecoveryWork() { return 0; } };
  const client = { async associationCandidates() { return []; } };
  const reconciler = { async reconcileAssociation() { reconciles++; return { status: 'pending', error: '404' }; } };
  const service = createSectionAssociationService({ client, store, reconciler, discoveryConfiguration: { mode: 'all', periods: [] },
    now: () => time, logger: { info() {}, warn() {}, error() {} } });
  const execution = { executionId: 'one-execution' };
  await service.fastTick({ execution });
  await service.recoveryTick({ execution, discoveryAlreadyCompleted: true });
  assert.equal(reconciles, 1);
});

function manualDiscoveryFixture({ time, discoveryConfiguration = { mode: 'auto', periods: [] }, lastFullAt = new Date(time) }) {
  const calls = [], persisted = [], monitorKinds = [], reconciled = [];
  const firstSeenAt = new Map();
  const offerings = {
    legacy: { Identifier: 701, Code: '002521-01-2602-I0001', Type: { Code: 'Course Offering' } },
    peoplesoft: { Identifier: 702, Code: 'ESPM-2602-GS2-C0011', Type: { Code: 'Course Offering' } }
  };
  const store = {
    async baselineStatus() { return { state: 'ready' }; },
    async lastFullDiscoveryAt() { return lastFullAt; },
    async recordDiscoveries(records) {
      persisted.push(...records);
      for (const item of records) firstSeenAt.set(String(item.id), new Date(time));
      return { newlyRecorded: records.length, alreadyKnown: 0 };
    },
    async countHistoricalBacklog() { return 0; },
    async listWaitingNew({ stabilityCutoff }) {
      return [...firstSeenAt].filter(([, seen]) => seen > stabilityCutoff)
        .map(([id]) => ({ associationOrgUnitId: id }));
    },
    async listFastWork() { return []; },
    async listMonitoringWork({ kind }) { monitorKinds.push(kind); return []; },
    async countDueMonitoring() { return 0; }
  };
  const client = { async associationCandidates(code) {
    calls.push(code);
    if (code === '2602-I0001') return [offerings.legacy];
    if (code === 'ESPM-2602-') return [offerings.peoplesoft];
    return [];
  } };
  const reconciler = { async reconcileAssociation(id) { reconciled.push(String(id)); return { status: 'completed' }; } };
  const service = createSectionAssociationService({ client, store, reconciler, discoveryConfiguration,
    now: () => time, logger: { info() {}, warn() {}, error() {} } });
  return { service, calls, persisted, monitorKinds, reconciled };
}

test('manual discovery at 00:15 searches configured periods after nightly broad discovery completed and keeps new work pending', async () => {
  const time = Date.parse('2026-10-20T03:15:00Z'); // 00:15 Sao Paulo
  const lastFullAt = new Date('2026-10-20T02:30:00Z'); // successful scan in the same logical nightly window
  const h = manualDiscoveryFixture({ time, lastFullAt });
  const result = await h.service.fastTick({ manualDiscovery: true });
  assert.deepEqual(h.calls, ['2601-I0001','ESPM-2601-','2602-I0001','ESPM-2602-','2701-I0001','ESPM-2701-']);
  assert.deepEqual(h.persisted.map(item => String(item.id)).sort(), ['701','702']);
  assert.equal(result.new, 2);
  assert.equal(result.pending, 2);
  assert.deepEqual(h.reconciled, []);
  assert.deepEqual(h.monitorKinds, []);
  assert.equal(result.discoveryActivities.historical, undefined);
});

test('manual discovery at 02:15 is period-scoped and does not start historical or cached-status work', async () => {
  const time = Date.parse('2026-10-20T05:15:00Z'); // 02:15 Sao Paulo
  const h = manualDiscoveryFixture({ time, discoveryConfiguration: { mode: 'explicit', periods: ['2501','2701'] } });
  const result = await h.service.fastTick({ manualDiscovery: true });
  assert.deepEqual(h.calls, ['2501-I0001','ESPM-2501-','2701-I0001','ESPM-2701-']);
  assert.deepEqual(h.monitorKinds, []);
  assert.equal(result.discoveryActivities.historical, undefined);
  assert.equal(result.statusChecksAttempted, 0);
});

test('manual discovery at 10:00 retains daytime discovery and child-monitor eligibility', async () => {
  const time = Date.parse('2026-10-20T13:00:00Z'); // 10:00 Sao Paulo
  const h = manualDiscoveryFixture({ time });
  const result = await h.service.fastTick({ manualDiscovery: true });
  assert.deepEqual(h.calls, ['2601-I0001','ESPM-2601-','2602-I0001','ESPM-2602-','2701-I0001','ESPM-2701-']);
  assert.deepEqual(h.monitorKinds, ['children']);
  assert.equal(result.discoveryActivities.periods, true);
});

test('manual all-period scope falls back to rolling periods while automatic eligibility remains unchanged', async () => {
  const time = Date.parse('2026-10-20T05:15:00Z');
  const manual = manualDiscoveryFixture({ time, discoveryConfiguration: { mode: 'all', periods: [] } });
  await manual.service.fastTick({ manualDiscovery: true });
  assert.deepEqual(manual.calls, ['2601-I0001','ESPM-2601-','2602-I0001','ESPM-2602-','2701-I0001','ESPM-2701-']);
  const automatic = manualDiscoveryFixture({ time, discoveryConfiguration: { mode: 'auto', periods: [] } });
  await automatic.service.fastTick();
  assert.deepEqual(automatic.calls, []);
  const daytime = manualDiscoveryFixture({ time: Date.parse('2026-10-20T13:00:00Z') });
  await daytime.service.fastTick();
  assert.deepEqual(daytime.calls, ['2601-I0001','ESPM-2601-','2602-I0001','ESPM-2602-','2701-I0001','ESPM-2701-']);
  assert.deepEqual(daytime.monitorKinds, ['children']);
});

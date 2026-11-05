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

test('operating windows use half-open Sao Paulo boundaries, including midnight and calendar rollover', () => {
  assert.equal(isReverificationWindow(Date.parse('2026-10-18T02:59:00Z')), false); // 23:59 previous local day
  assert.equal(isReverificationWindow(Date.parse('2026-10-18T03:00:00Z')), true); // 00:00
  assert.equal(isReverificationWindow(Date.parse('2026-10-18T08:59:00Z')), true); // 05:59
  assert.equal(isReverificationWindow(Date.parse('2026-10-18T09:00:00Z')), false); // 06:00
  assert.equal(isRegularOperationsWindow(Date.parse('2026-10-18T09:59:00Z')), false); // 06:59
  assert.equal(isRegularOperationsWindow(Date.parse('2026-10-18T10:00:00Z')), true); // 07:00
  assert.equal(isRegularOperationsWindow(Date.parse('2026-10-19T01:59:00Z')), true); // 22:59
  assert.equal(isRegularOperationsWindow(Date.parse('2026-10-19T02:00:00Z')), false); // 23:00
  assert.equal(isHistoricalDiscoveryWindow(Date.parse('2026-10-19T02:00:00Z')), true); // 23:00
  assert.equal(isHistoricalDiscoveryWindow(Date.parse('2026-10-19T03:00:00Z')), false); // midnight
  assert.equal(fullDiscoveryDue(new Date('2026-10-18T02:00:00Z'), Date.parse('2026-10-19T01:45:00Z')), false);
  assert.equal(fullDiscoveryDue(new Date('2026-10-18T02:00:00Z'), Date.parse('2026-10-19T02:00:00Z')), true);
  assert.equal(fullDiscoveryDue(null, Date.parse('2026-10-19T01:59:00Z')), false);
  assert.equal(fullDiscoveryDue(null, Date.parse('2026-10-19T02:00:00Z')), true);
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

test('broad discovery runs in the 23:00 window and period discovery resumes the next morning', async () => {
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

test('failed full discovery leaves its schedule unmarked for a retry in the remaining window', async () => {
  const h = makeService({ time: Date.parse('2026-10-19T02:15:00Z'), failFull: true });
  assert.equal((await h.service.fastTick()).status, 'completed');
  assert.equal(h.fullAt, null);
  assert.deepEqual(h.calls.filter(([kind]) => kind === 'query').map(([, code]) => code), ['I0001']);
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
  await service.fastTick();
  assert.equal(calls,0);
  assert.ok(writes.some(row=>row.lastSuccessfulChildInspectionAt instanceof Date));
  client.children = async()=>[...saved,{id:'14',code:'002521-01-2602-GS2-EL1U-00003'}].map(row=>({...row,Type:{Code:'Group'}}));
  await service.fastTick();
  assert.equal(calls,1);
});

test('night cached-ID verification records inactive results and sends active results to reconciliation', async()=>{
  const time=Date.parse('2026-10-18T03:15:00Z'); let active=false, reconciles=0; const writes=[];
  const store={async baselineStatus(){return {state:'ready'}},async lastFullDiscoveryAt(){return new Date(time)},
    async recordDiscoveries(){return {newlyRecorded:0,alreadyKnown:0}},async countHistoricalBacklog(){return 0},
    async listWaitingNew(){return []},async listFastWork(){return []},
    async listMonitoringWork({kind}){return kind==='status'?[{associationOrgUnitId:'7',associationCode:'002521-01-2602-I0001',
      verifiedMappingVersion:1,verifiedChildren:[{id:'12',code:'002521-01-2602-GS2-EL1S-00001'}],
      verifiedTargets:[{id:'90',code:'002521-01-2602-GS2-EL1S'}],verifiedMappings:[{sectionId:'12',sectionCode:'002521-01-2602-GS2-EL1S-00001',targetId:'90',targetCode:'002521-01-2602-GS2-EL1S'}]}]:[]},
    async record(id,fields){writes.push(fields)},async countDueMonitoring(){return 0}};
  const client={async associationCandidates(){return []},async course(){return {Identifier:90,Type:{Code:'Course Offering'},Code:'002521-01-2602-GS2-EL1S',IsActive:active}}};
  const reconciler={async reconcileAssociation(){reconciles++;return {status:'completed',targets:[{status:'already-inactive'}]}}};
  const service=createSectionAssociationService({client,store,reconciler,now:()=>time,logger:{info(){},warn(){},error(){}}});
  await service.fastTick();
  assert.equal(reconciles,0);
  assert.ok(writes.some(row=>row.lastSuccessfulStatusVerificationAt instanceof Date));
  active=true; await service.fastTick(); assert.equal(reconciles,1);
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

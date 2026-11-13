'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSectionAssociationClient } = require('../src/sectionAssociations/client');
const { createSectionAssociationService, academicPeriods, discoveryScope, isReverificationWindow, isRegularOperationsWindow,
  isHistoricalDiscoveryWindow, historicalWindowKey, fullDiscoveryDue } = require('../src/sectionAssociations/service');

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
  assert.equal(isReverificationWindow(Date.parse('2026-10-18T04:15:00Z')), true); // 01:15
  assert.equal(isReverificationWindow(Date.parse('2026-10-18T04:30:00Z')), true); // 01:30
  assert.equal(isReverificationWindow(Date.parse('2026-10-18T09:30:00Z')), false); // 06:30
  assert.equal(isReverificationWindow(Date.parse('2026-10-18T10:00:00Z')), false); // 07:00
  assert.equal(isRegularOperationsWindow(Date.parse('2026-10-18T09:59:00Z')), false); // 06:59
  assert.equal(isRegularOperationsWindow(Date.parse('2026-10-18T10:00:00Z')), true); // 07:00
  assert.equal(isRegularOperationsWindow(Date.parse('2026-10-19T01:59:00Z')), true); // 22:59
  assert.equal(isRegularOperationsWindow(Date.parse('2026-10-19T02:00:00Z')), false); // 23:00
  assert.equal(isHistoricalDiscoveryWindow(Date.parse('2026-10-19T02:00:00Z')), false); // 23:00
  assert.equal(isHistoricalDiscoveryWindow(Date.parse('2026-10-19T02:45:00Z')), false); // 23:45
  assert.equal(isHistoricalDiscoveryWindow(Date.parse('2026-10-19T03:00:00Z')), true); // 00:00
  assert.equal(isHistoricalDiscoveryWindow(Date.parse('2026-10-19T03:45:00Z')), true); // 00:45
  assert.equal(isHistoricalDiscoveryWindow(Date.parse('2026-10-19T04:00:00Z')), false); // 01:00
  assert.equal(historicalWindowKey(Date.parse('2026-10-19T03:00:00Z')), '2026-10-19');
  assert.equal(fullDiscoveryDue(new Date('2026-10-19T03:00:00Z'), Date.parse('2026-10-19T03:45:00Z')), false);
  assert.equal(fullDiscoveryDue(new Date('2026-10-19T03:15:00Z'), Date.parse('2026-10-19T03:45:00Z')), false);
  assert.equal(fullDiscoveryDue(new Date('2026-10-19T03:15:00Z'), Date.parse('2026-10-20T03:00:00Z')), true);
  assert.equal(fullDiscoveryDue(null, Date.parse('2026-10-19T02:59:00Z')), false);
  assert.equal(fullDiscoveryDue(null, Date.parse('2026-10-19T03:00:00Z')), true);
  for (let hour = 1; hour <= 6; hour++) {
    for (const minute of [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]) {
      const instant = Date.parse(`2026-10-18T${String(hour + 3).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`);
      assert.equal(isReverificationWindow(instant), hour < 6, `${hour}:${minute}`);
    }
  }
  assert.equal(isReverificationWindow(Date.parse('2026-10-18T03:00:00Z')), false); // before 01:00
  assert.equal(isReverificationWindow(Date.parse('2026-10-18T08:55:00Z')), true); // 05:55
  assert.equal(isReverificationWindow(Date.parse('2026-10-18T09:00:00Z')), false); // 06:00
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

function cachedStatusWork(id) {
  const targetId=String(Number(id)+1000);
  const childCode='002521-01-2602-GS2-EL1S-00001';
  const targetCode='002521-01-2602-GS2-EL1S';
  return {associationOrgUnitId:String(id),associationCode:'002521-01-2602-I0001',verifiedMappingVersion:1,
    verifiedChildren:[{id:'12',code:childCode}],verifiedTargets:[{id:targetId,code:targetCode}],
    verifiedMappings:[{sectionId:'12',sectionCode:childCode,targetId,targetCode}]};
}

async function runNightStatus({items,course,maxReconciliationsPerRun=50,statusVerificationBatchSize=150,
  newWork=[],childWork=[],routineWork=[]}={}) {
  const time=Date.parse('2026-10-18T04:05:00Z');
  const calls={course:[],reconciliations:[],writes:[]};let statusLimit=null;
  const store={async baselineStatus(){return{state:'ready'}},async lastFullDiscoveryAt(){return new Date(time)},
    async recordDiscoveries(){return{newlyRecorded:0,alreadyKnown:0}},async countHistoricalBacklog(){return 0},
    async listWaitingNew(){return[]},async listNewWork({limit,excludeIds=[]}={}){return newWork.filter(row=>!excludeIds.includes(String(row.associationOrgUnitId))).slice(0,limit)},
    async listPendingChildChangeWork({limit,excludeIds=[]}={}){return childWork.filter(row=>!excludeIds.includes(String(row.associationOrgUnitId))).slice(0,limit)},
    async listRoutineFastWork({limit,excludeIds=[]}={}){return routineWork.filter(row=>!excludeIds.includes(String(row.associationOrgUnitId))).slice(0,limit)},
    async listPendingStatusReconciliationWork(){return[]},async listMonitoringWork({kind,limit}){if(kind==='status'){statusLimit=limit;return items.slice(0,limit)}return[]},
    async record(id,fields){calls.writes.push({id,fields})},async countDueMonitoring(){return 554}};
  const client={async associationCandidates(){return[]},async course(id){calls.course.push(String(id));return course(id)}};
  const reconciler={async reconcileAssociation(id){calls.reconciliations.push(String(id));return{status:'completed',targets:[{status:'already-inactive'}]}}};
  const service=createSectionAssociationService({client,store,reconciler,maxReconciliationsPerRun,statusVerificationBatchSize,
    now:()=>time,logger:{info(){},warn(){},error(){}}});
  return {result:await service.fastTick(),calls,statusLimit};
}

function deferredStatusHarness({items,time,maxReconciliationsPerRun=20}) {
  let currentTime=time; const calls=[]; const targets=new Map(items.map(item=>[String(item.associationOrgUnitId),item]));
  const store={async baselineStatus(){return{state:'ready'}},async lastFullDiscoveryAt(){return new Date(currentTime)},
    async recordDiscoveries(){return{newlyRecorded:0,alreadyKnown:0}},async countHistoricalBacklog(){return 0},
    async listWaitingNew(){return[]},async listNewWork(){return[]},async listPendingChildChangeWork(){return[]},
    async listRoutineFastWork(){return[]},async listMonitoringWork({kind,limit,windowKey,attemptCutoff}){
      if(kind!=='status')return[];
      return items.filter(item=>(!item.lastSuccessfulStatusVerificationAt||item.lastSuccessfulStatusVerificationAt<windowKey)&&
        (!item.lastStatusVerificationAttemptAt||item.lastStatusVerificationAttemptAt<=attemptCutoff)).slice(0,limit);
    },
    async listPendingStatusReconciliationWork({limit,excludeIds=[]}){
      return items.filter(item=>item.pendingStatusReconciliationAt&&!excludeIds.includes(String(item.associationOrgUnitId)))
        .sort((a,b)=>a.pendingStatusReconciliationAt-b.pendingStatusReconciliationAt).slice(0,limit)
        .map(item=>({...item,workType:'status-reconciliation'}));
    },
    async countPendingStatusReconciliationWork(){return items.filter(item=>item.pendingStatusReconciliationAt).length},
    async clearStatusReconciliationPending(id){delete targets.get(String(id)).pendingStatusReconciliationAt},
    async record(id,fields){Object.assign(targets.get(String(id)),fields)},async countDueMonitoring(){return 0}};
  const client={async associationCandidates(){return[]},async course(id){const target=items.find(item=>
    item.verifiedTargets.some(mapping=>String(mapping.id)===String(id)));
    return{Identifier:String(id),Code:target.verifiedTargets[0].code,IsActive:!target.reconciled}}};
  const reconciler={async reconcileAssociation(id){const target=targets.get(String(id));target.reconciled=true;
    calls.push(String(id));return{status:'completed',writesVerified:1}}};
  const service=createSectionAssociationService({client,store,reconciler,maxReconciliationsPerRun,
    now:()=>currentTime,logger:{info(){},warn(){},error(){}}});
  return{items,calls,service,setTime(value){currentTime=value}};
}

test('broad discovery runs once from midnight to 01:00 and period discovery resumes at 07:00', async () => {
  const time = Date.parse('2026-10-19T03:15:00Z'); // 00:15 local
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

test('failed full discovery retries within the midnight-to-01:00 window', async () => {
  let time = Date.parse('2026-10-19T03:15:00Z'); // 00:15
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
  time = Date.parse('2026-10-19T03:45:00Z'); // 00:45 in the same nightly window
  failLegacy = false;
  assert.equal((await service.fastTick()).status, 'completed');
  assert.ok(fullAt instanceof Date);
  assert.deepEqual(queries, ['I0001', 'I0001', 'ESPM-']);
});

test('successful broad discovery at midnight does not repeat in the nightly window', async () => {
  let time = Date.parse('2026-10-19T03:00:00Z'); // 00:00
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
  time = Date.parse('2026-10-19T03:45:00Z'); // 00:45 same logical window
  await service.fastTick();
  assert.deepEqual(queries, ['I0001', 'ESPM-']);
  time = Date.parse('2026-10-20T03:00:00Z'); // next local day at midnight
  await service.fastTick();
  assert.deepEqual(queries, ['I0001', 'ESPM-', 'I0001', 'ESPM-']);
});

test('historical discovery runs at midnight and does not run period queries outside daytime', async () => {
  const time=Date.parse('2026-10-19T03:15:00Z');
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
  const all=makeService({time:Date.parse('2026-10-19T03:15:00Z'),discoveryConfiguration:{mode:'all',periods:[]}});
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
  const time=Date.parse('2026-10-19T03:00:00Z'); const calls=[]; let baselineRecords=[];
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

test('fast reconciliation capacity gives new, child-change, and routine work bounded fair shares', async()=>{
  const time=Date.parse('2026-11-06T15:15:00Z');
  const calls=[];
  const rows=(prefix,count)=>Array.from({length:count},(_,index)=>({associationOrgUnitId:`${prefix}-${index}`,
    associationCode:'ESPM-2602-GS2-C0011'}));
  const newRows=rows('new',20), childRows=rows('child',20), routineRows=rows('routine',20);
  const store={async baselineStatus(){return{state:'ready'}},async lastFullDiscoveryAt(){return new Date(time)},
    async recordDiscoveries(){return{newlyRecorded:0,alreadyKnown:0}},async countHistoricalBacklog(){return 0},
    async listWaitingNew(){return[]},async listNewWork({limit}){calls.push(['newLimit',limit]);return newRows.slice(0,limit)},
    async listPendingChildChangeWork({limit}){calls.push(['childLimit',limit]);return childRows.slice(0,limit)},
    async listRoutineFastWork({limit,excludeIds}){calls.push(['routineLimit',limit]);assert.deepEqual(excludeIds.length,34);return routineRows.slice(0,limit)},
    async listMonitoringWork(){return[]},async countDueMonitoring(){return 0},async countPendingChildChangeWork(){return 3}};
  const service=createSectionAssociationService({client:{async associationCandidates(){return[]}},store,
    reconciler:{async reconcileAssociation(id){calls.push(['reconcile',id]);return{status:'completed'}}},
    maxReconciliationsPerRun:50,now:()=>time,logger:{info(){},warn(){},error(){}}});
  const result=await service.fastTick();
  const processed=calls.filter(([kind])=>kind==='reconcile');
  assert.equal(result.processedThisRun,50);
  assert.equal(processed.length,50);
  assert.equal(calls.filter(([,id])=>String(id).startsWith('new-')).length,17);
  assert.equal(calls.filter(([,id])=>String(id).startsWith('child-')).length,17);
  assert.equal(calls.filter(([,id])=>String(id).startsWith('routine-')).length,16);
});

test('fast reconciliation work-conserves unused priority allocations without duplicates or exceeding the cap',async()=>{
  const time=Date.parse('2026-11-06T15:15:00Z');
  const rows=(prefix,count)=>Array.from({length:count},(_,index)=>({associationOrgUnitId:`${prefix}-${index}`,
    associationCode:'ESPM-2602-GS2-C0011'}));
  async function runScenario({newCount=0,childCount=0,routineCount=0,cap=50}){
    const calls=[]; const newRows=rows('new',newCount), childRows=rows('child',childCount), routineRows=rows('routine',routineCount);
    const take=(items,limit,excludeIds=[])=>items.filter(row=>!excludeIds.includes(String(row.associationOrgUnitId))).slice(0,limit);
    const store={async baselineStatus(){return{state:'ready'}},async lastFullDiscoveryAt(){return new Date(time)},
      async recordDiscoveries(){return{newlyRecorded:0,alreadyKnown:0}},async countHistoricalBacklog(){return 0},
      async listWaitingNew(){return[]},async listNewWork({limit,excludeIds=[]}){return take(newRows,limit,excludeIds)},
      async listPendingChildChangeWork({limit,excludeIds=[]}){return take(childRows,limit,excludeIds)},
      async listRoutineFastWork({limit,excludeIds=[]}){return take(routineRows,limit,excludeIds)}};
    const service=createSectionAssociationService({client:{async associationCandidates(){return[]}},store,
      reconciler:{async reconcileAssociation(id){calls.push(String(id));return{status:'completed'}}},
      maxReconciliationsPerRun:cap,discoveryConfiguration:{mode:'explicit',periods:['2602']},now:()=>time,
      logger:{info(){},warn(){},error(){}}});
    const result=await service.fastTick();
    assert.equal(result.processedThisRun,calls.length);
    assert.equal(new Set(calls).size,calls.length,'an association must not be processed twice');
    assert.ok(calls.length<=cap,'the configured reconciliation cap must hold');
    return {calls,result};
  }

  const manyNew=await runScenario({newCount:100});
  assert.equal(manyNew.calls.length,50);
  assert.equal(manyNew.calls.filter(id=>id.startsWith('new-')).length,50);
  const fewerNew=await runScenario({newCount:30});
  assert.equal(fewerNew.calls.length,30);
  const mixed=await runScenario({newCount:30,childCount:10});
  assert.equal(mixed.calls.length,40);
  const childPriority=await runScenario({newCount:100,childCount:20});
  assert.equal(childPriority.calls.length,50);
  assert.equal(childPriority.calls.filter(id=>id.startsWith('child-')).length,20);
  const mixedBacklogs=await runScenario({newCount:40,childCount:20});
  assert.equal(mixedBacklogs.calls.length,50);
  assert.equal(mixedBacklogs.calls.filter(id=>id.startsWith('child-')).length,20);
  assert.equal(mixedBacklogs.calls.filter(id=>id.startsWith('new-')).length,30);
  const routineFairness=await runScenario({newCount:100,routineCount:100});
  assert.equal(routineFairness.calls.length,50);
  assert.equal(routineFairness.calls.filter(id=>id.startsWith('routine-')).length,16);
  const routineOnly=await runScenario({routineCount:100});
  assert.equal(routineOnly.calls.length,50);
  assert.equal(routineOnly.calls.filter(id=>id.startsWith('routine-')).length,50);
  const configuredAboveHardLimit=await runScenario({newCount:100,cap:100});
  assert.equal(configuredAboveHardLimit.calls.length,50);
  const empty=await runScenario({});
  assert.equal(empty.calls.length,0);
});

test('a shared execution cannot exceed 50 reconciliations across repeated service calls',async()=>{
  const time=Date.parse('2026-11-06T15:15:00Z');const rows=Array.from({length:100},(_,index)=>({
    associationOrgUnitId:`same-execution-${index}`,associationCode:'ESPM-2602-GS2-C0011'}));
  const completed=new Set();const calls=[];
  const store={async baselineStatus(){return{state:'ready'}},async lastFullDiscoveryAt(){return new Date(time)},
    async recordDiscoveries(){return{newlyRecorded:0,alreadyKnown:0}},async countHistoricalBacklog(){return 0},
    async listWaitingNew(){return[]},async listNewWork({limit,excludeIds=[]}){return rows.filter(row=>
      !completed.has(row.associationOrgUnitId)&&!excludeIds.includes(row.associationOrgUnitId)).slice(0,limit)},
    async listPendingStatusReconciliationWork(){return[]},async listPendingChildChangeWork(){return[]},async listRoutineFastWork(){return[]}};
  const service=createSectionAssociationService({client:{async associationCandidates(){return[]}},store,
    maxReconciliationsPerRun:100,reconciler:{async reconcileAssociation(id){calls.push(id);completed.add(id);return{status:'completed'}}},
    now:()=>time,logger:{info(){},warn(){},error(){}}});
  const execution={executionId:'one-execution'};
  const first=await service.fastTick({execution,maxReconciliations:100});
  const second=await service.fastTick({execution,maxReconciliations:100});
  assert.equal(first.processedThisRun,50);assert.equal(second.processedThisRun,0);
  assert.equal(calls.length,50);assert.equal(new Set(calls).size,50);
});

test('daytime fast processing uses all 50 shared reconciliation slots when eligible work exists',async()=>{
  const time=Date.parse('2026-11-06T15:15:00Z'); const rows=Array.from({length:80},(_,index)=>({
    associationOrgUnitId:`day-${index}`,associationCode:'ESPM-2602-GS2-C0011'})); const calls=[];
  const store={async baselineStatus(){return{state:'ready'}},async lastFullDiscoveryAt(){return new Date(time)},
    async recordDiscoveries(){return{newlyRecorded:0,alreadyKnown:0}},async countHistoricalBacklog(){return 0},
    async listWaitingNew(){return[]},async listNewWork({limit,excludeIds=[]}){return rows.filter(row=>!excludeIds.includes(row.associationOrgUnitId)).slice(0,limit)},
    async listPendingStatusReconciliationWork(){return[]},async listPendingChildChangeWork(){return[]},async listRoutineFastWork(){return[]}};
  const service=createSectionAssociationService({client:{async associationCandidates(){return[]}},store,
    reconciler:{async reconcileAssociation(id){calls.push(String(id));return{status:'completed'}}},
    now:()=>time,logger:{info(){},warn(){},error(){}}});
  const result=await service.fastTick();
  assert.equal(result.processedThisRun,50);assert.equal(calls.length,50);assert.equal(new Set(calls).size,50);
});

test('daytime status backlog does not consume new-association or incremental-change priority shares',async()=>{
  const time=Date.parse('2026-11-06T15:15:00Z');const rows=(prefix,count)=>Array.from({length:count},(_,index)=>({
    associationOrgUnitId:`${prefix}-${index}`,associationCode:'ESPM-2602-GS2-C0011'}));
  const categories={new:rows('new',100),child:rows('child',100),status:rows('status',100),routine:rows('routine',100)};const calls=[];
  const select=(items,limit,excludeIds=[])=>items.filter(row=>!excludeIds.includes(String(row.associationOrgUnitId))).slice(0,limit);
  const store={async baselineStatus(){return{state:'ready'}},async lastFullDiscoveryAt(){return new Date(time)},
    async recordDiscoveries(){return{newlyRecorded:0,alreadyKnown:0}},async countHistoricalBacklog(){return 0},
    async listWaitingNew(){return[]},async listNewWork({limit,excludeIds=[]}){return select(categories.new,limit,excludeIds)},
    async listPendingChildChangeWork({limit,excludeIds=[]}){return select(categories.child,limit,excludeIds)},
    async listPendingStatusReconciliationWork({limit,excludeIds=[]}){return select(categories.status,limit,excludeIds)},
    async listRoutineFastWork({limit,excludeIds=[]}){return select(categories.routine,limit,excludeIds)}};
  const service=createSectionAssociationService({client:{async associationCandidates(){return[]}},store,
    reconciler:{async reconcileAssociation(id){calls.push(String(id));return{status:'completed'}}},now:()=>time,
    logger:{info(){},warn(){},error(){}}});
  const result=await service.fastTick();
  assert.equal(result.processedThisRun,50);
  assert.equal(calls.filter(id=>id.startsWith('new-')).length,17);
  assert.equal(calls.filter(id=>id.startsWith('child-')).length,17);
  assert.equal(calls.filter(id=>id.startsWith('status-')).length,8);
  assert.equal(calls.filter(id=>id.startsWith('routine-')).length,8);
});

test('night mixed workload shares 50 slots across new, incremental, routine, and reactivated offerings',async()=>{
  const rows=(prefix,count)=>Array.from({length:count},(_,index)=>({associationOrgUnitId:`${prefix}-${index}`,
    associationCode:'ESPM-2602-GS2-C0011'}));
  const h=await runNightStatus({items:Array.from({length:50},(_,index)=>cachedStatusWork(index+1)),
    newWork:rows('new',10),childWork:rows('child',10),routineWork:rows('routine',10),
    course:id=>({Identifier:String(id),Code:'002521-01-2602-GS2-EL1S',IsActive:true})});
  const reconciled=h.calls.reconciliations;
  assert.equal(h.result.processedThisRun,50);assert.equal(reconciled.length,50);assert.equal(new Set(reconciled).size,50);
  assert.equal(reconciled.filter(id=>id.startsWith('new-')).length,10);
  assert.equal(reconciled.filter(id=>id.startsWith('child-')).length,10);
  assert.equal(reconciled.filter(id=>id.startsWith('routine-')).length,10);
  assert.equal(reconciled.filter(id=>/^\d+$/.test(id)).length,20);
  assert.equal(h.result.statusReconciliationsDeferred,30);
});

test('deferred nighttime reactivations persist and consume remaining shared capacity next run',async()=>{
  const items=Array.from({length:50},(_,index)=>cachedStatusWork(index+1));
  const h=deferredStatusHarness({items,time:Date.parse('2026-10-18T04:05:00Z'),maxReconciliationsPerRun:20});
  const first=await h.service.fastTick();
  assert.equal(first.statusChecksAttempted,50);
  assert.equal(first.processedThisRun,20);assert.equal(first.statusReconciliationsDeferred,30);
  assert.equal(h.calls.length,20);assert.equal(new Set(h.calls).size,20);
  h.setTime(Date.parse('2026-10-18T04:10:00Z'));
  const second=await h.service.fastTick();
  assert.equal(second.processedThisRun,20);assert.equal(second.statusReconciliationsDeferred,10);
  assert.equal(h.calls.length,40);assert.equal(new Set(h.calls).size,40);
  h.setTime(Date.parse('2026-10-18T04:15:00Z'));
  const third=await h.service.fastTick();
  assert.equal(third.processedThisRun,10);assert.equal(third.statusReconciliationsDeferred,0);
  assert.equal(h.calls.length,50);assert.equal(new Set(h.calls).size,50);
});

test('fast scheduling does not reconcile an association twice when queues overlap',async()=>{
  const time=Date.parse('2026-11-06T15:15:00Z'); const calls=[];
  const duplicate={associationOrgUnitId:'same-id',associationCode:'ESPM-2602-GS2-C0011'};
  const store={async baselineStatus(){return{state:'ready'}},async lastFullDiscoveryAt(){return new Date(time)},
    async recordDiscoveries(){return{newlyRecorded:0,alreadyKnown:0}},async countHistoricalBacklog(){return 0},
    async listWaitingNew(){return[]},async listNewWork(){return[duplicate]},
    async listPendingChildChangeWork(){return[duplicate]},async listRoutineFastWork(){return[duplicate]}};
  const service=createSectionAssociationService({client:{async associationCandidates(){return[]}},store,
    reconciler:{async reconcileAssociation(id){calls.push(id);return{status:'completed'}}},
    discoveryConfiguration:{mode:'explicit',periods:['2602']},now:()=>time,logger:{info(){},warn(){},error(){}}});
  const result=await service.fastTick();
  assert.deepEqual(calls,['same-id']);
  assert.equal(result.processedThisRun,1);
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

test('failed child reads keep the prior success time and record a 15-minute failure cooldown', async()=>{
  const h=childDiagnosticFixture();
  h.client.children=async()=>{throw Object.assign(new Error('temporary read failure'),{status:503})};
  const result=await h.service.fastTick();
  assert.equal(result.childChecksAttempted,1);
  assert.equal(result.childChecksSucceeded,0);
  assert.equal(result.monitoringErrors,1);
  assert.ok(h.calls.records.some(row=>row.fields.childInspectionFailureCooldownUntil?.getTime()===
    Date.parse('2026-11-06T15:30:00Z')));
  assert.equal(h.calls.records.some(row=>row.fields.lastSuccessfulChildInspectionAt),false);
});

function childDiagnosticFixture({ debugAssociationId, ids = ['36183'], savedById = {}, currentById = {}, limit = 50,
  reconciliationResult = { status: 'completed', targets: [{ status: 'already-inactive' }] } } = {}) {
  const time = Date.parse('2026-11-06T15:15:00Z');
  const calls = { children: [], reconciliations: [], records: [] };
  const mappings = id => {
    const children = savedById[id] || [{ id: '36187', code: '012263-01-2601-POS-S51H-01125' }];
    return { verifiedMappingVersion: 1, verifiedChildren: children,
      verifiedTargets: children.map((child, index) => ({ id: String(90000 + index), code: child.code.slice(0, -6) })),
      verifiedMappings: children.map((child, index) => ({ sectionId: child.id, sectionCode: child.code,
        targetId: String(90000 + index), targetCode: child.code.slice(0, -6) })) };
  };
  const items = ids.map(id => ({ associationOrgUnitId: id, associationCode: '012263-01-2601-I0001',
    status: 'completed', reconciliationVersion: 1, ...mappings(id) }));
  const audits = [];
  const store = { async baselineStatus() { return { state: 'ready' }; }, async lastFullDiscoveryAt() { return new Date(time); },
    async recordDiscoveries() { return { newlyRecorded: 0, alreadyKnown: 0 }; }, async countHistoricalBacklog() { return 0; },
    async listWaitingNew() { return []; }, async listFastWork() { return []; },
    async listNewWork() { return []; }, async listRoutineFastWork() { return []; },
    async listPendingChildChangeWork({ limit }) { return items.filter(item => item.pendingChildChanges?.length).slice(0, limit); },
    async countPendingChildChangeWork() { return items.filter(item => item.pendingChildChanges?.length).length; },
    async listMonitoringWork({ kind }) { return kind === 'children' ? items : []; },
    async record(id, fields) { calls.records.push({ id, fields }); const item = items.find(row => row.associationOrgUnitId === id); if (item) Object.assign(item, fields); },
    async get(id) { return items.find(row => row.associationOrgUnitId === id); },
    async recordAudit(row) { if (!audits.some(item => item.executionId === row.executionId && item.recordKey === row.recordKey)) audits.push(row); },
    async countDueMonitoring() { return 0; } };
  const defaultChildren = id => savedById[id] || [{ id: '36187', code: '012263-01-2601-POS-S51H-01125' }];
  const client = { async associationCandidates() { return []; }, async children(id) {
    calls.children.push(id);
    return (currentById[id] || defaultChildren(id)).map(row => ({ Identifier: row.id, Code: row.code,
      Type: { Code: row.type || 'Group' } }));
  } };
  const reconciler = { async reconcileAssociation(id) {
    calls.reconciliations.push(id);
    return reconciliationResult;
  } };
  const lines = [];
  const service = createSectionAssociationService({ client, store, reconciler, maxReconciliationsPerRun: limit,
    childMonitoringBatchSize: ids.length, debugAssociationId,
    now: () => time, logger: { info(line) { lines.push(line); }, warn() {}, error() {} } });
  return { service, calls, lines, audits, items, client };
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

test('child-change audit records structural differences and reconciliation outcomes', async t => {
  const saved = [{ id: '36187', code: '012263-01-2601-POS-S51H-01125' },
    { id: '36190', code: '012263-01-2601-POS-S52H-01139' }];
  const added = { id: '36191', code: '012263-01-2601-POS-S53H-01140' };
  const execution = { executionId: '12345678-1234-1234-1234-123456789abc', source: 'automatic' };
  await t.test('addition with inactive original is reported without a correction', async () => {
    const h = childDiagnosticFixture({ savedById: { '36183': saved }, currentById: { '36183': [...saved, added] },
      reconciliationResult: { status: 'completed', targets: [{ id: '90002', code: '012263-01-2601-POS-S53H',
        sectionId: added.id, status: 'already-inactive' }] } });
    await h.service.fastTick({ execution });
    assert.deepEqual(h.audits.map(row => [row.kind, row.changeType, row.reconciliationOutcome]), [
      ['child-change', 'child-added', 'Detected; reconciliation pending/deferred'],
      ['child-change', 'child-added', 'Reconciliation completed; no correction required']
    ]);
    assert.equal(h.audits[0].childSectionD2lId, '36191');
    assert.equal(h.audits[1].relatedOriginalCourseOfferingD2lId, '90002');
  });
  await t.test('addition with verified deactivation is reported as completed with correction', async () => {
    const h = childDiagnosticFixture({ savedById: { '36183': saved }, currentById: { '36183': [...saved, added] },
      reconciliationResult: { status: 'completed', targets: [{ id: '90002', code: '012263-01-2601-POS-S53H',
        sectionId: added.id, status: 'verified-inactive' }] } });
    await h.service.fastTick({ execution });
    assert.equal(h.audits.at(-1).reconciliationOutcome, 'Reconciliation completed; correction performed');
  });
  await t.test('removal preserves the former child and its verified target without reactivation', async () => {
    const h = childDiagnosticFixture({ savedById: { '36183': saved }, currentById: { '36183': [saved[0]] } });
    await h.service.fastTick({ execution });
    assert.equal(h.audits[0].changeType, 'child-removed');
    assert.equal(h.audits[0].childSectionD2lId, saved[1].id);
    assert.equal(h.audits[0].previousChildSectionOrgCode, saved[1].code);
    assert.equal(h.audits[0].currentChildSectionOrgCode, '');
    assert.equal(h.audits[0].relatedOriginalCourseOfferingD2lId, '90001');
    assert.equal(h.calls.reconciliations.length, 1);
  });
  await t.test('same child ID with a different code is identified by ID', async () => {
    const changed = { ...saved[1], code: '012263-01-2601-POS-S52H-01141' };
    const h = childDiagnosticFixture({ savedById: { '36183': saved }, currentById: { '36183': [saved[0], changed] } });
    await h.service.fastTick({ execution });
    assert.equal(h.audits[0].changeType, 'child-code-changed');
    assert.equal(h.audits[0].previousChildSectionOrgCode, saved[1].code);
    assert.equal(h.audits[0].currentChildSectionOrgCode, changed.code);
  });
});

test('multiple genuine child changes each receive a row, while response ordering receives none', async () => {
  const saved = [{ id: '36187', code: '012263-01-2601-POS-S51H-01125' },
    { id: '36190', code: '012263-01-2601-POS-S52H-01139' }];
  const h = childDiagnosticFixture({ savedById: { '36183': saved }, currentById: { '36183': [
    { id: '36191', code: '012263-01-2601-POS-S53H-01140' }] } });
  await h.service.fastTick({ execution: { executionId: '12345678-1234-1234-1234-123456789abc', source: 'manual' } });
  assert.deepEqual(h.audits.filter(row => row.recordKey.startsWith('detection:')).map(row => row.changeType),
    ['child-removed', 'child-removed', 'child-added']);
  const noChange = childDiagnosticFixture({ savedById: { '36183': saved }, currentById: { '36183': [...saved].reverse() } });
  await noChange.service.fastTick({ execution: { executionId: '12345678-1234-1234-1234-123456789abc', source: 'automatic' } });
  assert.equal(noChange.audits.length, 0);
});

test('child-change audit survives a deferred reconciliation and reports blocked work', async () => {
  const saved = [{ id: '36187', code: '012263-01-2601-POS-S51H-01125' }];
  const h = childDiagnosticFixture({ limit: 0, savedById: { '36183': saved }, currentById: { '36183': [
    ...saved, { id: '36190', code: '012263-01-2601-POS-S52H-01139' }] } });
  const deferred = await h.service.fastTick({ execution: { executionId: '12345678-1234-1234-1234-123456789abc', source: 'automatic' } });
  assert.equal(h.calls.reconciliations.length, 0);
  assert.equal(h.audits.length, 1);
  assert.equal(h.items[0].pendingChildChanges.length, 1);
  assert.equal(deferred.childChangeReconciliationsDeferred, 1);
  assert.match(h.audits[0].reconciliationOutcome, /pending\/deferred/);
});

test('repeated observation reuses the original detection and a later run links its outcome', async () => {
  const saved = [{ id: '36187', code: '012263-01-2601-POS-S51H-01125' }];
  const current = [...saved, { id: '36190', code: '012263-01-2601-POS-S52H-01139' }];
  const h = childDiagnosticFixture({ savedById: { '36183': saved }, currentById: { '36183': current },
    reconciliationResult: { status: 'pending', error: 'temporary read failure' } });
  const detection = { executionId: '12345678-1234-1234-1234-123456789abc', source: 'automatic' };
  await h.service.fastTick({ execution: detection });
  assert.equal(h.audits.filter(row => row.auditEvent === 'detected').length, 1);
  assert.equal(h.audits[0].reconciliationOutcome, 'Detected; reconciliation pending/deferred');
  const outcome = { status: 'completed', targets: [{ id: '90001', code: '012263-01-2601-POS-S52H',
    sectionId: '36190', status: 'already-inactive' }] };
  h.service = createSectionAssociationService({
    client: { async associationCandidates() { return []; }, async children() { return current.map(row => ({ Identifier: row.id,
      Code: row.code, Type: { Code: 'Group' } })); } },
    store: { async baselineStatus() { return { state: 'ready' }; }, async lastFullDiscoveryAt() { return new Date(Date.parse('2026-11-06T15:15:00Z')); },
      async recordDiscoveries() { return { newlyRecorded: 0, alreadyKnown: 0 }; }, async countHistoricalBacklog() { return 0; },
      async listWaitingNew() { return []; }, async listFastWork() { return []; }, async listNewWork() { return []; },
      async listRoutineFastWork() { return []; }, async listPendingChildChangeWork({ limit }) { return h.items.filter(item => item.pendingChildChanges?.length).slice(0, limit); },
      async countPendingChildChangeWork() { return h.items.filter(item => item.pendingChildChanges?.length).length; },
      async listMonitoringWork({ excludeIds = [] }) { return h.items.filter(item => !excludeIds.includes(item.associationOrgUnitId)); },
      async record(id, fields) { Object.assign(h.items[0], fields); }, async get() { return h.items[0]; },
      async recordAudit(row) { if (!h.audits.some(item => item.executionId === row.executionId && item.recordKey === row.recordKey)) h.audits.push(row); },
      async countDueMonitoring() { return 0; } },
    reconciler: { async reconcileAssociation() { return outcome; } }, now: () => Date.parse('2026-11-06T15:15:00Z'),
    logger: { info() {}, warn() {}, error() {} }
  });
  const later = { executionId: '22345678-1234-1234-1234-123456789abc', source: 'manual' };
  await h.service.fastTick({ execution: later });
  const detections = h.audits.filter(row => row.auditEvent === 'detected');
  assert.equal(detections.length, 1);
  const resolution = h.audits.find(row => row.auditEvent === 'reconciliation-outcome' && row.executionId === later.executionId);
  assert.equal(resolution.executionId, later.executionId);
  assert.equal(resolution.detectionExecutionId, detection.executionId);
  assert.equal(resolution.detectionRecordKey, detections[0].detectionRecordKey);
  assert.equal(resolution.reconciliationOutcome, 'Reconciliation completed; no correction required');
});

test('blocked reconciliation is recorded without writing a correction or inventing a target', async () => {
  const h = childDiagnosticFixture({ currentById: { '36183': [
    { id: '36187', code: '012263-01-2601-POS-S51H-01125' },
    { id: '36190', code: '012263-01-2601-POS-S52H-01139' }] },
  reconciliationResult: { status: 'blocked', error: 'validation failed' } });
  await h.service.fastTick({ execution: { executionId: '12345678-1234-1234-1234-123456789abc', source: 'automatic' } });
  const outcome = h.audits.find(row => row.auditEvent === 'reconciliation-outcome');
  assert.equal(outcome.reconciliationOutcome, 'Reconciliation blocked or failed');
  assert.equal(outcome.relatedOriginalCourseOfferingD2lId, '');
  assert.equal(outcome.relatedOriginalCourseOfferingOrgCode, '');
});

test('dry-run active targets remain pending and do not claim a correction', async () => {
  const h = childDiagnosticFixture({ currentById: { '36183': [
    { id: '36187', code: '012263-01-2601-POS-S51H-01125' },
    { id: '36190', code: '012263-01-2601-POS-S52H-01139' }] },
  reconciliationResult: { status: 'pending', targets: [{ id: '90001', code: '012263-01-2601-POS-S52H',
    sectionId: '36190', status: 'would-inactivate' }] } });
  await h.service.fastTick({ execution: { executionId: '12345678-1234-1234-1234-123456789abc', source: 'automatic' } });
  assert.equal(h.audits.some(row => row.auditEvent === 'reconciliation-outcome'), false);
  assert.equal(h.audits.every(row => row.reconciliationOutcome === 'Detected; reconciliation pending/deferred'), true);
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
  const result = await invalid.service.fastTick({ execution: { executionId: '12345678-1234-1234-1234-123456789abc', source: 'automatic' } });
  const line = invalid.lines.find(row => row.includes('child monitoring diagnostic'));
  assert.match(line, /mappingTrusted=false/);
  assert.match(line, /mappingFailure=empty-children/);
  assert.match(line, /reconciliationReason=invalid-mapping/);
  assert.match(line, /reconciliationDisposition=scheduled/);
  assert.deepEqual(invalid.calls.children, []);
  assert.deepEqual(invalid.calls.reconciliations, ['36183']);
  assert.equal(result.childChecksAttempted, 0);
  assert.equal(invalid.audits.length, 0);
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
  assert.match(line, /successfulInspectionTimestampUpdated=true/);
  assert.deepEqual(h.calls.reconciliations, ['36183']);
  assert.equal(result.childChangesDetected, 2);
  assert.equal(h.calls.children.length, 2);
});

test('night cached-ID verification runs every five minutes and accepts the documented CourseOffering fields', async()=>{
  let time=Date.parse('2026-10-18T04:15:00Z'); let active=false, reconciles=0, statusQueries=0, statusLimit; const writes=[];
  const store={async baselineStatus(){return {state:'ready'}},async lastFullDiscoveryAt(){return new Date(time)},
    async recordDiscoveries(){return {newlyRecorded:0,alreadyKnown:0}},async countHistoricalBacklog(){return 0},
    async listWaitingNew(){return []},async listFastWork(){return []},
    async listMonitoringWork({kind,limit}){if(kind==='status'){statusQueries++;statusLimit=limit;}return kind==='status'?[{associationOrgUnitId:'7',associationCode:'002521-01-2602-I0001',
      verifiedMappingVersion:1,verifiedChildren:[{id:'12',code:'002521-01-2602-GS2-EL1S-00001'}],
      verifiedTargets:[{id:'90',code:'002521-01-2602-GS2-EL1S'}],verifiedMappings:[{sectionId:'12',sectionCode:'002521-01-2602-GS2-EL1S-00001',targetId:'90',targetCode:'002521-01-2602-GS2-EL1S'}]}]:[]},
    async record(id,fields){writes.push(fields)},async countDueMonitoring(){return 0}};
  const client={async associationCandidates(){return []},async course(){return {Identifier:90,Code:'002521-01-2602-GS2-EL1S',IsActive:active}}};
  const reconciler={async reconcileAssociation(){reconciles++;return {status:'completed',targets:[{status:'already-inactive'}]}}};
  const service=createSectionAssociationService({client,store,reconciler,now:()=>time,logger:{info(){},warn(){},error(){}}});
  const checked = await service.fastTick();
  assert.equal(statusQueries,1);
  assert.equal(statusLimit,50);
  assert.equal(reconciles,0);
  assert.equal(checked.statusChecksSucceeded,1);
  assert.equal(checked.statusAssociationsVerified,1);
  assert.equal(checked.statusChangesDetected,0);
  assert.ok(writes.some(row=>row.lastSuccessfulStatusVerificationAt instanceof Date));
  time=Date.parse('2026-10-18T04:30:00Z');
  active=true; await service.fastTick(); assert.equal(statusQueries,2); assert.equal(reconciles,1);
});

test('night verification checks 50 offerings in one five-minute run and reports actual compliant results',async()=>{
  const items=Array.from({length:50},(_,index)=>cachedStatusWork(index+1));
  const h=await runNightStatus({items,course:id=>({Identifier:String(id),Code:'002521-01-2602-GS2-EL1S',IsActive:false})});
  assert.equal(h.statusLimit,50);
  assert.equal(h.result.statusChecksAttempted,50);
  assert.equal(h.result.statusChecksSucceeded,50);
  assert.equal(h.result.statusAssociationsVerified,50);
  assert.equal(h.result.statusChangesDetected,0);
  assert.equal(h.result.processedThisRun,0);
  assert.equal(h.result.statusMonitoringLag,554);
  assert.equal(h.calls.reconciliations.length,0);
  assert.equal(h.calls.writes.filter(row=>row.fields.lastSuccessfulStatusVerificationAt instanceof Date).length,50);
});

test('night verification discrepancies use all available reconciliation capacity, not the daytime 17-slot share',async()=>{
  const items=Array.from({length:50},(_,index)=>cachedStatusWork(index+1));
  const h=await runNightStatus({items,maxReconciliationsPerRun:100,
    course:id=>({Identifier:String(id),Code:'002521-01-2602-GS2-EL1S',IsActive:true})});
  assert.equal(h.statusLimit,50);
  assert.equal(h.result.statusChecksAttempted,50);
  assert.equal(h.result.statusAssociationsVerified,0);
  assert.equal(h.result.statusChangesDetected,50);
  assert.equal(h.result.statusReconciliationsPerformed,50);
  assert.equal(h.result.statusCourseOfferingCorrections,0);
  assert.equal(h.result.statusReconciliationsDeferred,0);
  assert.equal(h.result.processedThisRun,50);
  assert.equal(h.calls.reconciliations.length,50);
  assert.equal(new Set(h.calls.reconciliations).size,50);
});

test('night verification still honors a smaller global reconciliation cap and records deferred work',async()=>{
  const items=Array.from({length:50},(_,index)=>cachedStatusWork(index+1));
  const h=await runNightStatus({items,maxReconciliationsPerRun:20,
    course:id=>({Identifier:String(id),Code:'002521-01-2602-GS2-EL1S',IsActive:true})});
  assert.equal(h.result.statusChecksAttempted,50);
  assert.equal(h.result.statusChangesDetected,50);
  assert.equal(h.result.statusReconciliationsPerformed,20);
  assert.equal(h.result.statusReconciliationsDeferred,30);
  assert.equal(h.result.processedThisRun,20);
  assert.equal(h.calls.reconciliations.length,20);
});

test('night verification reconciles incorrect identities, codes, malformed responses and missing targets safely',async()=>{
  const cases=[
    ['incorrect ID',id=>({Identifier:String(Number(id)+1),Code:'002521-01-2602-GS2-EL1S',IsActive:false})],
    ['incorrect code',id=>({Identifier:String(id),Code:'wrong-code',IsActive:false})],
    ['malformed response',()=>null],
    ['missing target',()=>{throw Object.assign(new Error('not found'),{status:404})}]
  ];
  for(const [label,course] of cases){
    const h=await runNightStatus({items:[cachedStatusWork(7)],course});
    assert.equal(h.result.statusChangesDetected,1,label);
    assert.equal(h.result.statusReconciliationsPerformed,1,label);
    assert.equal(h.result.processedThisRun,1,label);
    assert.deepEqual(h.calls.reconciliations,['7'],label);
  }
});

test('pending reconciliation and status verification run during the same five-minute nighttime cycle', async () => {
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
  assert.equal(statusQueries, 1);
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

test('manual discovery at 02:15 is period-scoped and allows normally scheduled status verification', async () => {
  const time = Date.parse('2026-10-20T05:15:00Z'); // 02:15 Sao Paulo
  const h = manualDiscoveryFixture({ time, discoveryConfiguration: { mode: 'explicit', periods: ['2501','2701'] } });
  const result = await h.service.fastTick({ manualDiscovery: true });
  assert.deepEqual(h.calls, ['2501-I0001','ESPM-2501-','2701-I0001','ESPM-2701-']);
  assert.deepEqual(h.monitorKinds, ['status']);
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

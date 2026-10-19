'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSectionAssociationClient } = require('../src/sectionAssociations/client');
const { createSectionAssociationService, academicPeriods, discoveryScope, isReverificationWindow, fullDiscoveryDue } = require('../src/sectionAssociations/service');

test('academic periods use Sao Paulo local date, semester convention, and year rollover', () => {
  assert.deepEqual(academicPeriods(Date.parse('2026-10-18T15:00:00Z')), { mode:'auto', previous:'2601', current:'2602', next:'2701', periods:['2601','2602','2701'] });
  assert.deepEqual(academicPeriods(Date.parse('2027-01-01T02:30:00Z')), { mode:'auto', previous:'2601', current:'2602', next:'2701', periods:['2601','2602','2701'] });
  assert.deepEqual(academicPeriods(Date.parse('2027-01-01T03:30:00Z')), { mode:'auto', previous:'2602', current:'2701', next:'2702', periods:['2602','2701','2702'] });
  assert.deepEqual(academicPeriods(Date.parse('2026-06-30T23:30:00Z')), { mode:'auto', previous:'2502', current:'2601', next:'2602', periods:['2502','2601','2602'] });
  assert.deepEqual(academicPeriods(Date.parse('2026-07-01T03:00:00Z')), { mode:'auto', previous:'2601', current:'2602', next:'2701', periods:['2601','2602','2701'] });
  assert.deepEqual(discoveryScope({mode:'explicit',periods:['2601']},Date.now()),{mode:'explicit',periods:['2601']});
  assert.deepEqual(discoveryScope({mode:'all',periods:[]},Date.now()),{mode:'all',periods:[]});
});

test('maintenance window and full discovery due checks use Sao Paulo boundaries', () => {
  assert.equal(isReverificationWindow(Date.parse('2026-10-18T05:59:00Z')), false); // 02:59 local
  assert.equal(isReverificationWindow(Date.parse('2026-10-18T06:00:00Z')), true); // 03:00 local
  assert.equal(isReverificationWindow(Date.parse('2026-10-18T08:59:00Z')), true); // 05:59 local
  assert.equal(isReverificationWindow(Date.parse('2026-10-18T09:00:00Z')), false); // 06:00 local
  assert.equal(fullDiscoveryDue(new Date('2026-10-18T04:59:00Z'), Date.parse('2026-10-18T04:59:00Z')), false);
  assert.equal(fullDiscoveryDue(new Date('2026-10-18T04:59:00Z'), Date.parse('2026-10-18T05:00:00Z')), true);
  assert.equal(fullDiscoveryDue(new Date('2026-10-17T05:00:00Z'), Date.parse('2026-10-18T04:00:00Z')), false);
  assert.equal(fullDiscoveryDue(new Date('2026-10-17T05:00:00Z'), Date.parse('2026-10-18T05:00:00Z')), true);
});

test('Brightspace discovery accepts only broad or period-specific codes and paginates each query', async () => {
  const requested = [];
  const client = createSectionAssociationClient({ baseUrl: 'https://tenant.example', lpVersion: '1.60', oauth: {}, http: async () => {},
    get: async url => { requested.push(url); return { Items: [], PagingInfo: { HasMoreItems: false } }; } });
  await client.associationCandidates('2602-I0001');
  await client.associationCandidates('2601-I0001');
  await client.associationCandidates('I0001');
  assert.deepEqual(requested.map(url => new URL(url).searchParams.get('orgUnitCode')),
    ['2602-I0001', '2601-I0001', 'I0001']);
  assert.throws(() => client.associationCandidates('history-I0001'), /Invalid Section Association discovery code/);
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
    return code === 'I0001' || duplicateAcrossQueries ? [association] : [];
  } };
  const service = createSectionAssociationService({ client, store, reconciler: {}, discoveryConfiguration, now: () => time, logger: { info() {}, warn() {}, error() {} } });
  return { service, calls, store, persisted, get fullAt() { return fullAt; } };
}

test('nightly full discovery persists success once and resumes with period discovery on later invocations', async () => {
  const time = Date.parse('2026-10-18T05:15:00Z'); // 02:15 local
  const h = makeService({ time });
  const first = await h.service.fastTick();
  assert.equal(first.status, 'completed');
  assert.deepEqual(first.discoveryPeriods, { mode:'auto', previous:'2601', current:'2602', next:'2701', periods:['2601','2602','2701'] });
  assert.deepEqual(first.discoveryActivities, { historical:true, periods:true });
  assert.ok(h.fullAt instanceof Date);
  assert.deepEqual(h.calls.filter(([kind]) => kind === 'query').map(([, code]) => code), ['I0001', '2601-I0001', '2602-I0001', '2701-I0001']);
  h.calls.length = 0;
  assert.equal((await h.service.fastTick()).status, 'completed');
  assert.deepEqual(h.calls.filter(([kind]) => kind === 'query').map(([, code]) => code), ['2601-I0001', '2602-I0001', '2701-I0001']);
});

test('failed full discovery leaves its schedule unmarked for the next cron invocation', async () => {
  const h = makeService({ time: Date.parse('2026-10-18T05:15:00Z'), failFull: true });
  assert.equal((await h.service.fastTick()).status, 'completed');
  assert.equal(h.fullAt, null);
  assert.deepEqual(h.calls.filter(([kind]) => kind === 'query').map(([, code]) => code),
    ['I0001', '2601-I0001', '2602-I0001', '2701-I0001']);
});

test('period evidence is omitted when period discovery fails after a successful historical query', async () => {
  const time=Date.parse('2026-10-18T05:15:00Z');
  const calls=[];
  const store={async baselineStatus(){return {state:'ready'}},async lastFullDiscoveryAt(){return null},
    async markFullDiscoveryCompleted(){},async recordDiscoveries(){return {newlyRecorded:0,alreadyKnown:0}},
    async countHistoricalBacklog(){return 0},async listWaitingNew(){return []},async listFastWork(){return []}};
  const client={async associationCandidates(code){calls.push(code);if(code==='2601-I0001')throw new Error('previous period failed');return []}};
  const service=createSectionAssociationService({client,store,reconciler:{},now:()=>time,logger:{info(){},warn(){},error(){}}});
  const result=await service.fastTick();
  assert.equal(result.status,'failed');
  assert.equal(result.discoveryPeriods,undefined);
  assert.deepEqual(result.discoveryActivities,{historical:true});
  assert.deepEqual(calls,['I0001','2601-I0001','2602-I0001','2701-I0001']);
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
  assert.deepEqual(result.discoveryActivities,{periods:true,reverification:true});
});

test('explicit discovery queries configured periods and all mode reuses one broad query', async () => {
  const explicit=makeService({time:Date.parse('2026-10-18T15:00:00Z'),discoveryConfiguration:{mode:'explicit',periods:['2601','2701']}});
  const explicitResult=await explicit.service.fastTick();
  assert.deepEqual(explicitResult.discoveryPeriods,{mode:'explicit',periods:['2601','2701']});
  assert.deepEqual(explicit.calls.filter(([kind])=>kind==='query').map(([,code])=>code),['I0001','2601-I0001','2701-I0001']);
  const all=makeService({time:Date.parse('2026-10-18T15:00:00Z'),discoveryConfiguration:{mode:'all',periods:[]}});
  const allResult=await all.service.fastTick();
  assert.deepEqual(allResult.discoveryPeriods,{mode:'all',periods:[]});
  assert.deepEqual(all.calls.filter(([kind])=>kind==='query').map(([,code])=>code),['I0001']);
  assert.ok(all.fullAt instanceof Date);
});

test('valid association IDs are deduplicated across broad and period searches before persistence', async () => {
  const h=makeService({time:Date.parse('2026-10-18T15:00:00Z'),duplicateAcrossQueries:true,
    discoveryConfiguration:{mode:'explicit',periods:['2601','2602']}});
  const result=await h.service.fastTick();
  assert.equal(result.discovered,1);
  assert.equal(h.persisted.filter(record=>String(record.id)==='7').length,1);
});

test('completed re-verification is offered only during the maintenance window', async () => {
  const outside = makeService({ time: Date.parse('2026-10-18T09:15:00Z') });
  await outside.service.fastTick();
  assert.equal(outside.calls.find(([kind]) => kind === 'work')[1], false);
  const inside = makeService({ time: Date.parse('2026-10-18T06:15:00Z') });
  await inside.service.fastTick();
  assert.equal(inside.calls.find(([kind]) => kind === 'work')[1], true);
});

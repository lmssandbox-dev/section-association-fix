'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSectionAssociationStore } = require('../src/sectionAssociations/store');

function matches(record, filter) {
  for (const [key, expected] of Object.entries(filter)) {
    if (key === '$or') {
      if (!expected.some(part => matches(record, part))) return false;
      continue;
    }
    if (key === '$and') {
      if (!expected.every(part => matches(record, part))) return false;
      continue;
    }
    const actual = record[key];
    if (expected && typeof expected === 'object' && !(expected instanceof Date)) {
      if ('$ne' in expected && actual === expected.$ne) return false;
      if ('$exists' in expected && (actual !== undefined) !== expected.$exists) return false;
      if ('$in' in expected && !expected.$in.includes(actual)) return false;
      if ('$nin' in expected && expected.$nin.includes(actual)) return false;
      if ('$lte' in expected && !(actual instanceof Date && actual <= expected.$lte)) return false;
      if ('$gte' in expected && !(actual instanceof Date && actual >= expected.$gte)) return false;
      if ('$lt' in expected && !(actual instanceof Date && actual < expected.$lt)) return false;
      if ('$gt' in expected && !(actual instanceof Date && actual > expected.$gt)) return false;
      if ('$regex' in expected && (typeof actual !== 'string' || !expected.$regex.test(actual))) return false;
    } else if (actual !== expected) return false;
  }
  return true;
}

function makeStore(records, metaDocuments = new Map()) {
  const associations = {
    createIndex: async () => {},
    find(filter) {
      let rows = records.filter(record => matches(record, filter));
      return {
        sort(order) {
          rows = [...rows].sort((a, b) => {
            for (const [key, direction] of Object.entries(order)) {
              const left = a[key]; const right = b[key];
              const cmp = left === undefined ? (right === undefined ? 0 : -1) :
                right === undefined ? 1 : left < right ? -1 : left > right ? 1 : 0;
              if (cmp) return cmp * direction;
            }
            return 0;
          });
          return this;
        },
        limit(count) { rows = rows.slice(0, count); return this; },
        skip(count) { rows = rows.slice(count); return this; },
        async toArray() { return rows.map(row => ({ ...row })); }
      };
    },
    async countDocuments(filter) { return records.filter(record => matches(record, filter)).length; },
    async updateOne(filter, update) {
      const record = records.find(row => matches(row, filter));
      if (!record) return { matchedCount: 0 };
      Object.assign(record, structuredClone(update.$set || {}));
      if (update.$unset) for (const key of Object.keys(update.$unset)) delete record[key];
      return { matchedCount: 1 };
    }
  };
  const meta = {
    async createIndex() {},
    async findOne(filter) { return structuredClone(metaDocuments.get(filter._id) || null); },
    find(filter) {
      let rows = [...metaDocuments.values()].filter(row => matches(row, filter));
      const cursor = { sort(order) { rows.sort((a,b) => (b.startedAt || 0) - (a.startedAt || 0)); return cursor; },
        skip(count) { rows = rows.slice(count); return cursor; }, limit(count) { rows = rows.slice(0,count); return cursor; },
        batchSize() { return cursor; }, async toArray() { return structuredClone(rows); },
        async *[Symbol.asyncIterator]() { for (const row of structuredClone(rows)) yield row; } };
      return cursor;
    },
    async deleteMany(filter) { for (const id of filter._id.$in) metaDocuments.delete(id); },
    async updateOne(filter, update, options = {}) {
      let doc = metaDocuments.get(filter._id);
      const eligible = !doc || !filter.$or || filter.$or.some(part =>
        (part.startedAt?.$lte && doc.startedAt <= part.startedAt.$lte) ||
        (part.startedAt?.$exists === false && doc.startedAt === undefined));
      if (!eligible) {
        if (options.upsert) throw Object.assign(new Error('duplicate key'), { code: 11000 });
        return { matchedCount: 0, upsertedCount: 0 };
      }
      const inserted = !doc;
      if (!doc) { doc = { _id: filter._id }; metaDocuments.set(filter._id, doc); }
      Object.assign(doc, structuredClone(update.$set));
      if (update.$unset) for (const key of Object.keys(update.$unset)) delete doc[key];
      return { matchedCount: inserted ? 0 : 1, upsertedCount: inserted ? 1 : 0 };
    }
  };
  const mongoClient = { db: () => ({ collection(name) { return name === 'section_association_meta' ? meta : associations; } }) };
  return { store: createSectionAssociationStore({ namespace: 'tenant', mongoClient }), metaDocuments, mongoClient };
}

const date = minutes => new Date(1_000_000 + minutes * 60_000);
const item = (id, fields = {}) => ({ namespace: 'tenant', associationOrgUnitId: String(id), firstSeenAt: date(0), status: 'pending', baseline: false, ...fields });

test('legacy baseline completed records without verification evidence are eligible and selection is bounded/deterministic', async () => {
  const { store } = makeStore([
    item(9, { baseline: true, status: 'completed' }),
    item(3, { baseline: true, status: 'completed', reconciliationVersion: 1, lastReconciledAt: date(0), lastVerifiedAt: date(0) }),
    item(2, { firstSeenAt: date(-20) }),
    item(1, { firstSeenAt: date(-20) })
  ]);
  const selected = await store.listFastWork({ limit: 2, stabilityCutoff: date(0) });
  assert.deepEqual(selected.map(row => row.associationOrgUnitId), ['1', '2']);
  assert.deepEqual(selected.map(row => row.workType), ['new', 'new']);
  const next = await store.listFastWork({ limit: 2, stabilityCutoff: date(0) });
  assert.deepEqual(next.map(row => row.associationOrgUnitId), ['1', '2']);
  const one = await store.listFastWork({ limit: 3, stabilityCutoff: date(0) });
  assert.deepEqual(one.map(row => row.associationOrgUnitId), ['1', '2', '9']);
  assert.equal(await store.countHistoricalBacklog(), 1);
});

test('legacy baseline completion leaves the eligible set after verified evidence is persisted', async () => {
  const legacy = item(81, { baseline: true, status: 'completed' });
  const { store } = makeStore([legacy]);
  const args = { limit: 10, stabilityCutoff: date(0) };
  assert.deepEqual((await store.listFastWork(args)).map(row => row.associationOrgUnitId), ['81']);
  legacy.lastReconciledAt = date(1);
  legacy.lastVerifiedAt = date(1);
  legacy.reconciliationVersion = 1;
  assert.deepEqual(await store.listFastWork(args), []);
  assert.equal(await store.countHistoricalBacklog(), 0);
});

test('new and historical work remain prioritized; completed verification is selected only when explicitly enabled', async () => {
  const { store } = makeStore([
    item(20, { baseline: true, status: 'completed' }),
    item(10, { firstSeenAt: date(-20) }),
    item(30, { status: 'completed', reconciliationVersion: 1, lastReconciledAt: date(-30), lastVerifiedAt: date(-25) })
  ]);
  const fast = await store.listFastWork({ limit: 2, stabilityCutoff: date(0) });
  assert.deepEqual(fast.map(row => row.associationOrgUnitId), ['10', '20']);
  const recovery = await store.listRecoveryWork({ limit: 3, stabilityCutoff: date(0), blockedBefore: date(-1), reverifyBefore: date(-24) });
  assert.deepEqual(recovery.map(row => row.associationOrgUnitId), ['10', '20']);
  const maintenance = await store.listFastWork({ limit: 3, stabilityCutoff: date(0),
    includeCompletedReverification: true, reverifyBefore: date(-24) });
  assert.deepEqual(maintenance.map(row => row.associationOrgUnitId), ['10', '20', '30']);
  assert.equal(await store.countDueCompleted(date(-24)), 1);
});

test('baseline marker remains audit metadata and historical work is not gated by stability time', async () => {
  const { store } = makeStore([item(77, { baseline: true, status: 'pending', firstSeenAt: date(-500) })]);
  const selected = await store.listFastWork({ limit: 1, stabilityCutoff: date(-1000) });
  assert.equal(selected.length, 1);
  assert.equal(selected[0].baseline, true);
  assert.equal(selected[0].workType, 'historical');
});

test('bounded selection advances past recently checked pending records', async () => {
  const { store } = makeStore([
    item(1, { baseline: true, lastCheckedAt: date(20) }),
    item(2, { baseline: true, lastCheckedAt: date(30) }),
    item(3, { baseline: true })
  ]);
  const selected = await store.listFastWork({ limit: 1, stabilityCutoff: date(0) });
  assert.deepEqual(selected.map(row => row.associationOrgUnitId), ['3']);
});

test('deferred status reconciliations are durable, prioritized, and clear after success', async()=>{
  const {store}=makeStore([
    item(1,{status:'completed',reconciliationVersion:1,pendingStatusReconciliationAt:date(20)}),
    item(2,{status:'completed',reconciliationVersion:1,pendingStatusReconciliationAt:date(10)}),
    item(3,{status:'completed',reconciliationVersion:1})
  ]);
  const args={limit:1};
  assert.deepEqual((await store.listPendingStatusReconciliationWork(args)).map(row=>row.associationOrgUnitId),['2']);
  assert.equal(await store.countPendingStatusReconciliationWork(),2);
  await store.clearStatusReconciliationPending('2');
  assert.deepEqual((await store.listPendingStatusReconciliationWork({limit:5})).map(row=>row.associationOrgUnitId),['1']);
  assert.equal(await store.countPendingStatusReconciliationWork(),1);
});

test('new associations and durable child changes have separate prioritized selections', async()=>{
  const {store}=makeStore([
    item(1,{firstSeenAt:date(-10)}),
    item(2,{lastCheckedAt:date(1)}),
    item(3,{status:'completed',reconciliationVersion:1,pendingChildChanges:[{signature:'change',detectionTimestamp:date(2)}]}),
    item(4,{lastCheckedAt:date(3)})
  ]);
  assert.deepEqual((await store.listNewWork({limit:5,stabilityCutoff:date(0)})).map(row=>row.associationOrgUnitId),['1']);
  assert.deepEqual(await store.listNewWork({limit:5,stabilityCutoff:date(0),excludeIds:['1']}),[]);
  assert.deepEqual((await store.listPendingChildChangeWork({limit:5})).map(row=>row.associationOrgUnitId),['3']);
  assert.deepEqual(await store.listPendingChildChangeWork({limit:5,excludeIds:['3']}),[]);
  assert.equal(await store.countPendingChildChangeWork(),1);
  assert.deepEqual((await store.listRoutineFastWork({limit:5,excludeIds:['4']})).map(row=>row.associationOrgUnitId),['2']);
});

test('blocked associations enter recovery only after their retry interval', async () => {
  const { store } = makeStore([item(91, { status: 'blocked', lastCheckedAt: date(0) })]);
  const args = { limit: 10, stabilityCutoff: date(100), blockedBefore: date(-10), reverifyBefore: date(-100) };
  assert.deepEqual(await store.listRecoveryWork(args), []);
  const retry = await store.listRecoveryWork({ ...args, blockedBefore: date(1) });
  assert.deepEqual(retry.map(row => row.associationOrgUnitId), ['91']);
  assert.equal(retry[0].workType, 'blocked');
});

test('child monitoring selects oldest successful checks continuously and honors failure cooldown', async()=>{
  const records=[
    item(1,{status:'completed',reconciliationVersion:1,associationCode:'002521-01-2602-I0001',lastSuccessfulChildInspectionAt:date(50),lastChildInspectionAttemptAt:date(20)}),
    item(2,{status:'completed',reconciliationVersion:1,associationCode:'ESPM-2602-GS2-C0011',lastSuccessfulChildInspectionAt:date(150),lastChildInspectionAttemptAt:date(150),childInspectionFailureCooldownUntil:date(150)}),
    item(3,{status:'completed',reconciliationVersion:1,associationCode:'002521-01-2602-I0002',lastSuccessfulChildInspectionAt:date(250)}),
    item(4,{status:'completed',reconciliationVersion:1,associationCode:'ESPM-2602-GS2-C0012',lastSuccessfulChildInspectionAt:date(175),lastStatusVerificationAttemptAt:date(150),lastChildInspectionAttemptAt:date(150),childInspectionFailureCooldownUntil:date(150)})
  ];
  const {store}=makeStore(records);
  const selected=await store.listMonitoringWork({kind:'children',periods:['2602'],limit:10,attemptCutoff:date(149)});
  assert.deepEqual(selected.map(row=>row.associationOrgUnitId),['1','3']);
  assert.equal(await store.countDueMonitoring({kind:'children',periods:['2602'],before:date(200),attemptCutoff:date(149)}),1);
  records[0].lastSuccessfulChildInspectionAt=date(300);
  records[0].lastChildInspectionAttemptAt=date(300);
  assert.deepEqual((await store.listMonitoringWork({kind:'children',periods:['2602'],limit:10,attemptCutoff:date(200)}))
    .map(row=>row.associationOrgUnitId),['2','4','3','1']);
  assert.equal(await store.countDueMonitoring({kind:'children',periods:['2602'],before:date(200),attemptCutoff:date(200)}),2);
});

test('two oldest-first batches cover all 604 associations and the next batch rotates back fairly', async()=>{
  const records=Array.from({length:604},(_,index)=>item(index+1,{status:'completed',reconciliationVersion:1,
    associationCode:'ESPM-2602-GS2-C0011',lastSuccessfulChildInspectionAt:date(0)}));
  const {store}=makeStore(records);
  const first=await store.listMonitoringWork({kind:'children',periods:['2602'],limit:320,attemptCutoff:date(0)});
  assert.equal(first.length,320);
  assert.equal(new Set(first.map(row=>row.associationOrgUnitId)).size,320);
  for(const [index,row] of first.entries()) { const stored=records.find(record=>record.associationOrgUnitId===row.associationOrgUnitId);
    stored.lastSuccessfulChildInspectionAt=new Date(date(5).getTime()+index);
    stored.lastChildInspectionAttemptAt=stored.lastSuccessfulChildInspectionAt; }
  const second=await store.listMonitoringWork({kind:'children',periods:['2602'],limit:320,attemptCutoff:date(5)});
  assert.equal(second.length,320);
  assert.equal(new Set(second.map(row=>row.associationOrgUnitId)).size,320);
  assert.equal(second.filter(row=>!first.some(firstRow=>firstRow.associationOrgUnitId===row.associationOrgUnitId)).length,284);
  assert.equal(second.filter(row=>first.some(firstRow=>firstRow.associationOrgUnitId===row.associationOrgUnitId)).length,36);
  for(const [index,row] of second.entries()) { const stored=records.find(record=>record.associationOrgUnitId===row.associationOrgUnitId);
    stored.lastSuccessfulChildInspectionAt=new Date(date(10).getTime()+index);
    stored.lastChildInspectionAttemptAt=stored.lastSuccessfulChildInspectionAt; }
  const third=await store.listMonitoringWork({kind:'children',periods:['2602'],limit:320,attemptCutoff:date(10)});
  assert.equal(third.length,320);
  assert.equal(new Set(third.map(row=>row.associationOrgUnitId)).size,320);
  assert.equal(third.filter(row=>first.some(firstRow=>firstRow.associationOrgUnitId===row.associationOrgUnitId) &&
    !second.some(secondRow=>secondRow.associationOrgUnitId===row.associationOrgUnitId)).length,284);
  assert.equal(third.filter(row=>second.some(secondRow=>secondRow.associationOrgUnitId===row.associationOrgUnitId) &&
    !first.some(firstRow=>firstRow.associationOrgUnitId===row.associationOrgUnitId)).length,36);
  for(const [index,row] of third.entries()) { const stored=records.find(record=>record.associationOrgUnitId===row.associationOrgUnitId);
    stored.lastSuccessfulChildInspectionAt=new Date(date(15).getTime()+index);
    stored.lastChildInspectionAttemptAt=stored.lastSuccessfulChildInspectionAt; }
  const fourth=await store.listMonitoringWork({kind:'children',periods:['2602'],limit:320,attemptCutoff:date(15)});
  assert.equal(fourth.length,320);
  assert.equal(new Set(fourth.map(row=>row.associationOrgUnitId)).size,320);
  assert.equal(fourth.filter(row=>second.some(secondRow=>secondRow.associationOrgUnitId===row.associationOrgUnitId) &&
    !third.some(thirdRow=>thirdRow.associationOrgUnitId===row.associationOrgUnitId)).length,284);
  assert.equal(fourth.filter(row=>third.some(thirdRow=>thirdRow.associationOrgUnitId===row.associationOrgUnitId)).length,36);
});

test('800 associations rotate oldest-first without starvation',async()=>{
  const records=Array.from({length:800},(_,index)=>item(index+1,{status:'completed',reconciliationVersion:1,
    associationCode:'ESPM-2602-GS2-C0011',lastSuccessfulChildInspectionAt:date(0)}));
  const {store}=makeStore(records);
  const inspected=new Map();
  for(let run=0;run<5;run++){
    const selected=await store.listMonitoringWork({kind:'children',periods:['2602'],limit:320,attemptCutoff:date(run*5)});
    assert.equal(selected.length,320);
    assert.equal(new Set(selected.map(row=>row.associationOrgUnitId)).size,320);
    for(const row of selected){
      inspected.set(row.associationOrgUnitId,(inspected.get(row.associationOrgUnitId)||0)+1);
      const stored=records.find(record=>record.associationOrgUnitId===row.associationOrgUnitId);
      stored.lastSuccessfulChildInspectionAt=date((run+1)*5);
      stored.lastChildInspectionAttemptAt=date((run+1)*5);
    }
  }
  assert.equal(inspected.size,800);
  assert.ok([...inspected.values()].every(count=>count>=1 && count<=3));
});

test('child monitoring remains restricted to configured academic periods',async()=>{
  const {store}=makeStore([
    item(1,{status:'completed',reconciliationVersion:1,associationCode:'ESPM-2602-GS2-C0011'}),
    item(2,{status:'completed',reconciliationVersion:1,associationCode:'ESPM-2701-GS2-C0011'}),
    item(3,{status:'pending',reconciliationVersion:1,associationCode:'ESPM-2602-GS2-C0012'})
  ]);
  const selected=await store.listMonitoringWork({kind:'children',periods:['2602'],limit:10,attemptCutoff:date(0)});
  assert.deepEqual(selected.map(row=>row.associationOrgUnitId),['1']);
});

test('night cached-status selection retains its once-per-local-day marker', async()=>{
  const {store}=makeStore([
    item(1,{status:'completed',reconciliationVersion:1,associationCode:'ESPM-2602-GS2-C0011',
      lastSuccessfulStatusVerificationAt:date(90),lastStatusVerificationAttemptAt:date(90)}),
    item(2,{status:'completed',reconciliationVersion:1,associationCode:'ESPM-2602-GS2-C0012',
      lastSuccessfulStatusVerificationAt:date(70),lastStatusVerificationAttemptAt:date(70)})
  ]);
  const selected=await store.listMonitoringWork({kind:'status',periods:['2602'],limit:10,
    windowKey:date(80),attemptCutoff:date(100)});
  assert.deepEqual(selected.map(row=>row.associationOrgUnitId),['2']);
});

test('nightly status pass resumes after restart and covers 604 associations in 13 batches of at most 50',async()=>{
  const records=Array.from({length:604},(_,index)=>item(index+1,{status:'completed',reconciliationVersion:1,
    associationCode:'ESPM-2602-GS2-C0011',lastSuccessfulStatusVerificationAt:date(0),lastStatusVerificationAttemptAt:date(0)}));
  const windowKey=date(100); const checked=new Set(); const batches=[];
  for(let batch=0;batch<13;batch++){
    const store=makeStore(records).store; // Recreate the store wrapper to simulate a worker restart.
    const rows=await store.listMonitoringWork({kind:'status',periods:['2602'],limit:50,windowKey,
      attemptCutoff:date(100+batch*5)});
    batches.push(rows.length);
    assert.equal(new Set(rows.map(row=>row.associationOrgUnitId)).size,rows.length);
    for(const row of rows){
      assert.equal(checked.has(row.associationOrgUnitId),false);
      checked.add(row.associationOrgUnitId);
      const stored=records.find(record=>record.associationOrgUnitId===row.associationOrgUnitId);
      stored.lastStatusVerificationAttemptAt=date(101+batch*5);
      stored.lastSuccessfulStatusVerificationAt=date(101+batch*5);
    }
  }
  assert.deepEqual(batches,[50,50,50,50,50,50,50,50,50,50,50,50,4]);
  assert.equal(checked.size,604);
  assert.deepEqual(await makeStore(records).store.listMonitoringWork({kind:'status',periods:['2602'],limit:50,windowKey,
    attemptCutoff:date(200)}),[]);
  assert.equal(await makeStore(records).store.countDueMonitoring({kind:'status',periods:['2602'],before:windowKey}),0);
});

test('failed status checks retry after the controlled attempt cooldown and unfinished work is due next pass',async()=>{
  const {store}=makeStore([
    item(1,{status:'completed',reconciliationVersion:1,associationCode:'ESPM-2602-GS2-C0011',
      lastSuccessfulStatusVerificationAt:date(50),lastStatusVerificationAttemptAt:date(100)}),
    item(2,{status:'completed',reconciliationVersion:1,associationCode:'ESPM-2602-GS2-C0012',
      lastSuccessfulStatusVerificationAt:date(100)})
  ]);
  const samePass={kind:'status',periods:['2602'],limit:10,windowKey:date(90)};
  assert.deepEqual(await store.listMonitoringWork({...samePass,attemptCutoff:date(99)}),[]);
  assert.deepEqual((await store.listMonitoringWork({...samePass,attemptCutoff:date(100)})).map(row=>row.associationOrgUnitId),['1']);
  const nextPass=await store.listMonitoringWork({...samePass,windowKey:date(200),attemptCutoff:date(200)});
  assert.deepEqual(nextPass.map(row=>row.associationOrgUnitId),['1','2']);
});

test('successful full discovery timestamp is persisted across store instances', async () => {
  const metaDocuments = new Map();
  const first = makeStore([], metaDocuments).store;
  const completedAt = await first.markFullDiscoveryCompleted();
  const second = makeStore([], metaDocuments).store;
  assert.deepEqual(await second.lastFullDiscoveryAt(), completedAt);
});

test('latest maintenance summary is shared across store instances and ordered by start timestamp across sources', async () => {
  const { store, metaDocuments, mongoClient } = makeStore([]);
  const automatic = { executionId: 'auto-1', source: 'automatic', startedAt: date(10), completedAt: date(11), status: 'completed', associationsChecked: 2 };
  const manual = { executionId: 'manual-1', source: 'manual', startedAt: date(12), completedAt: date(13), status: 'failed', errors: 1 };
  assert.equal(await store.saveMaintenanceExecution(automatic), true);
  assert.equal(await store.saveMaintenanceExecution(manual), true);
  assert.equal(await store.saveMaintenanceExecution({ ...automatic, executionId: 'old-auto', startedAt: date(9) }), false);
  const restartedStore = createSectionAssociationStore({ namespace: 'tenant', mongoClient });
  assert.deepEqual(await restartedStore.latestMaintenanceExecution(), manual);
  assert.equal(metaDocuments.size, 4);
  assert.deepEqual((await restartedStore.recentMaintenanceExecutions()).map(run => run.executionId), ['manual-1', 'auto-1', 'old-auto']);
});

test('execution history is retained incrementally, idempotent by execution ID, and queried newest first', async () => {
  const { store } = makeStore([]);
  for (let i=0;i<60;i++) await store.saveMaintenanceExecution({ executionId:`run-${i}`, source:i%2?'manual':'automatic', startedAt:date(i), completedAt:date(i+1), status:'completed' });
  await store.saveMaintenanceExecution({ executionId:'run-59', source:'automatic', startedAt:date(59), completedAt:date(60), status:'completed' });
  assert.deepEqual((await store.recentMaintenanceExecutions()).map(run=>run.executionId), Array.from({length:50}, (_, i) => `run-${59-i}`));
  const exported = [];
  for await (const run of store.allMaintenanceExecutions()) exported.push(run.executionId);
  assert.equal(exported.length, 60);
  assert.equal(await store.recentMaintenanceExecutions(3).then(result => result.length), 3);
});

test('execution history pages are stable, date-filtered, and indicate whether another page exists', async () => {
  const { store } = makeStore([]);
  for (let i=0;i<123;i++) await store.saveMaintenanceExecution({ executionId:`run-${String(i).padStart(3,'0')}`, source:'automatic', startedAt:date(i), status:'completed' });
  const first = await store.recentMaintenanceExecutions(50,{page:1});
  const second = await store.recentMaintenanceExecutions(50,{page:2});
  const third = await store.recentMaintenanceExecutions(50,{page:3});
  assert.equal(first.hasMore,true);assert.equal(second.hasMore,true);assert.equal(third.hasMore,false);
  assert.equal(first.length,50);assert.equal(second.length,50);assert.equal(third.length,23);
  assert.equal(first[49].executionId,'run-073');assert.equal(second[0].executionId,'run-072');
  const filtered = await store.recentMaintenanceExecutions(50,{page:1,from:date(40),to:date(44)});
  assert.deepEqual(filtered.map(run=>run.executionId),['run-043','run-042','run-041','run-040']);
  const empty = await store.recentMaintenanceExecutions(50,{page:99});assert.deepEqual([...empty],[]);assert.equal(empty.hasMore,false);
});

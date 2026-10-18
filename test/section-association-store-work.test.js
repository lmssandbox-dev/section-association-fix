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
    const actual = record[key];
    if (expected && typeof expected === 'object' && !(expected instanceof Date)) {
      if ('$ne' in expected && actual === expected.$ne) return false;
      if ('$exists' in expected && (actual !== undefined) !== expected.$exists) return false;
      if ('$in' in expected && !expected.$in.includes(actual)) return false;
      if ('$lte' in expected && !(actual instanceof Date && actual <= expected.$lte)) return false;
      if ('$gt' in expected && !(actual instanceof Date && actual > expected.$gt)) return false;
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
    async countDocuments(filter) { return records.filter(record => matches(record, filter)).length; }
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

test('new work is prioritized before historical work and due completed records are selected only in recovery', async () => {
  const { store } = makeStore([
    item(20, { baseline: true, status: 'completed' }),
    item(10, { firstSeenAt: date(-20) }),
    item(30, { status: 'completed', reconciliationVersion: 1, lastReconciledAt: date(-30), lastVerifiedAt: date(-25) })
  ]);
  const fast = await store.listFastWork({ limit: 2, stabilityCutoff: date(0) });
  assert.deepEqual(fast.map(row => row.associationOrgUnitId), ['10', '20']);
  const recovery = await store.listRecoveryWork({ limit: 3, stabilityCutoff: date(0), blockedBefore: date(-1), reverifyBefore: date(-24) });
  assert.deepEqual(recovery.map(row => row.associationOrgUnitId), ['10', '20', '30']);
  assert.deepEqual(recovery.map(row => row.workType), ['new', 'historical', 'reverify']);
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

test('blocked associations enter recovery only after their retry interval', async () => {
  const { store } = makeStore([item(91, { status: 'blocked', lastCheckedAt: date(0) })]);
  const args = { limit: 10, stabilityCutoff: date(100), blockedBefore: date(-10), reverifyBefore: date(-100) };
  assert.deepEqual(await store.listRecoveryWork(args), []);
  const retry = await store.listRecoveryWork({ ...args, blockedBefore: date(1) });
  assert.deepEqual(retry.map(row => row.associationOrgUnitId), ['91']);
  assert.equal(retry[0].workType, 'blocked');
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
  assert.equal(await store.recentMaintenanceExecutions(3).then(rows => rows.length), 3);
});

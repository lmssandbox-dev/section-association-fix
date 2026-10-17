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

function makeStore(records) {
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
        async toArray() { return rows.map(row => ({ ...row })); }
      };
    },
    async countDocuments(filter) { return records.filter(record => matches(record, filter)).length; }
  };
  const meta = { async findOne() { return null; } };
  const mongoClient = { db: () => ({ collection(name) { return name === 'section_association_meta' ? meta : associations; } }) };
  return createSectionAssociationStore({ namespace: 'tenant', mongoClient });
}

const date = minutes => new Date(1_000_000 + minutes * 60_000);
const item = (id, fields = {}) => ({ namespace: 'tenant', associationOrgUnitId: String(id), firstSeenAt: date(0), status: 'pending', baseline: false, ...fields });

test('legacy baseline completed records without verification evidence are eligible and selection is bounded/deterministic', async () => {
  const store = makeStore([
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
  const store = makeStore([legacy]);
  const args = { limit: 10, stabilityCutoff: date(0) };
  assert.deepEqual((await store.listFastWork(args)).map(row => row.associationOrgUnitId), ['81']);
  legacy.lastReconciledAt = date(1);
  legacy.lastVerifiedAt = date(1);
  legacy.reconciliationVersion = 1;
  assert.deepEqual(await store.listFastWork(args), []);
  assert.equal(await store.countHistoricalBacklog(), 0);
});

test('new work is prioritized before historical work and due completed records are selected only in recovery', async () => {
  const store = makeStore([
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
  const store = makeStore([item(77, { baseline: true, status: 'pending', firstSeenAt: date(-500) })]);
  const selected = await store.listFastWork({ limit: 1, stabilityCutoff: date(-1000) });
  assert.equal(selected.length, 1);
  assert.equal(selected[0].baseline, true);
  assert.equal(selected[0].workType, 'historical');
});

test('bounded selection advances past recently checked pending records', async () => {
  const store = makeStore([
    item(1, { baseline: true, lastCheckedAt: date(20) }),
    item(2, { baseline: true, lastCheckedAt: date(30) }),
    item(3, { baseline: true })
  ]);
  const selected = await store.listFastWork({ limit: 1, stabilityCutoff: date(0) });
  assert.deepEqual(selected.map(row => row.associationOrgUnitId), ['3']);
});

test('blocked associations enter recovery only after their retry interval', async () => {
  const store = makeStore([item(91, { status: 'blocked', lastCheckedAt: date(0) })]);
  const args = { limit: 10, stabilityCutoff: date(100), blockedBefore: date(-10), reverifyBefore: date(-100) };
  assert.deepEqual(await store.listRecoveryWork(args), []);
  const retry = await store.listRecoveryWork({ ...args, blockedBefore: date(1) });
  assert.deepEqual(retry.map(row => row.associationOrgUnitId), ['91']);
  assert.equal(retry[0].workType, 'blocked');
});

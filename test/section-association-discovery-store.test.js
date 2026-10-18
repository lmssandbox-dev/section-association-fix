'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSectionAssociationStore } = require('../src/sectionAssociations/store');

function fakeMongo(initial = []) {
  const rows = new Map(initial.map(row => [`${row.namespace}:${row.associationOrgUnitId}`, { ...row }]));
  const queries = [];
  const writes = [];
  let failBulk = null;
  let raceRow = null;
  const associations = {
    async createIndex() {},
    find(filter) {
      const ids = filter.associationOrgUnitId?.$in;
      queries.push(ids?.length ?? null);
      return { async toArray() { return [...rows.values()].filter(row => row.namespace === filter.namespace &&
        (!ids || ids.includes(row.associationOrgUnitId))).map(row => ({ associationOrgUnitId: row.associationOrgUnitId })); } };
    },
    async bulkWrite(operations) {
      writes.push(operations);
      if (failBulk && operations[0]?.updateOne?.update?.$setOnInsert) {
        const error = failBulk; failBulk = null;
        if (raceRow) rows.set(`${raceRow.namespace}:${raceRow.associationOrgUnitId}`, { ...raceRow });
        throw error;
      }
      let upsertedCount = 0;
      let matchedCount = 0;
      for (const { updateOne } of operations) {
        const key = `${updateOne.filter.namespace}:${updateOne.filter.associationOrgUnitId}`;
        const existing = rows.get(key);
        if (existing) {
          Object.assign(existing, updateOne.update.$set || {});
          matchedCount++;
        } else if (updateOne.upsert) {
          const inserted = { ...updateOne.update.$setOnInsert };
          rows.set(key, inserted);
          upsertedCount++;
        }
      }
      return { upsertedCount, matchedCount };
    }
  };
  const client = { db() { return { collection(name) { return name === 'section_associations' ? associations : { async createIndex() {} }; } }; } };
  return { store: createSectionAssociationStore({ namespace: 'tenant', mongoClient: client, now: () => 1000 }), rows, queries, writes,
    fail(error, racedRecord = null) { failBulk = error; raceRow = racedRecord; } };
}

test('batched discovery preserves known state, refreshes lastSeenAt, inserts only new records, and counts accurately', async () => {
  const prior = { namespace: 'tenant', associationOrgUnitId: '1', associationCode: 'old', firstSeenAt: new Date(10),
    lastSeenAt: new Date(20), status: 'completed', baseline: true, reconciliationVersion: 1, lastVerifiedAt: new Date(30) };
  const { store, rows, writes } = fakeMongo([prior]);
  const counts = await store.recordDiscoveries([{ id: '1', code: 'updated' }, { id: '2', code: 'new' }, { id: '2', code: 'duplicate' }]);
  assert.deepEqual(counts, { newlyRecorded: 1, alreadyKnown: 1 });
  const known = rows.get('tenant:1');
  assert.equal(known.firstSeenAt.getTime(), 10);
  assert.equal(known.status, 'completed');
  assert.equal(known.baseline, true);
  assert.equal(known.reconciliationVersion, 1);
  assert.equal(known.lastVerifiedAt.getTime(), 30);
  assert.equal(known.lastSeenAt.getTime(), 1000);
  const inserted = rows.get('tenant:2');
  assert.equal(inserted.baseline, false);
  assert.equal(inserted.status, 'pending');
  assert.equal(inserted.firstSeenAt.getTime(), 1000);
  assert.equal(writes.length, 2);
  assert.equal(writes[1][0].updateOne.update.$setOnInsert.associationOrgUnitId, '2');
});

test('empty discovery is a no-op and reports zero counters', async () => {
  const { store, queries, writes } = fakeMongo();
  assert.deepEqual(await store.recordDiscoveries([]), { newlyRecorded: 0, alreadyKnown: 0 });
  assert.deepEqual(queries, []);
  assert.deepEqual(writes, []);
});

test('all-known discovery refreshes the seen timestamp without upserting records', async () => {
  const { store, rows, writes } = fakeMongo([{ namespace: 'tenant', associationOrgUnitId: '3', firstSeenAt: new Date(5),
    lastSeenAt: new Date(6), status: 'blocked', baseline: true, lastError: 'validation' }]);
  assert.deepEqual(await store.recordDiscoveries([{ id: '3', code: 'code' }]), { newlyRecorded: 0, alreadyKnown: 1 });
  assert.equal(writes.length, 1);
  assert.equal(rows.get('tenant:3').status, 'blocked');
  assert.equal(rows.get('tenant:3').lastError, 'validation');
  assert.equal(rows.get('tenant:3').firstSeenAt.getTime(), 5);
});

test('discovery bounds ID comparisons and bulk writes at 500 records', async () => {
  const { store, queries, writes } = fakeMongo();
  const rows = Array.from({ length: 1001 }, (_, index) => ({ id: String(index), code: 'code' }));
  assert.deepEqual(await store.recordDiscoveries(rows), { newlyRecorded: 1001, alreadyKnown: 0 });
  assert.deepEqual(queries, [500, 500, 1]);
  assert.deepEqual(writes.map(batch => batch.length), [500, 500, 1]);
});

test('duplicate-key insertion race is counted as already known after confirming the raced record exists', async () => {
  const { store, fail } = fakeMongo();
  fail(Object.assign(new Error('duplicate key'), { writeErrors: [{ code: 11000 }], result: { nUpserted: 0 } }),
    { namespace: 'tenant', associationOrgUnitId: '7', baseline: true, status: 'completed' });
  assert.deepEqual(await store.recordDiscoveries([{ id: '7', code: 'code' }]), { newlyRecorded: 0, alreadyKnown: 1 });
});

test('partial bulk failures surface to the caller', async () => {
  const { store, fail } = fakeMongo();
  fail(Object.assign(new Error('bulk write failed'), { writeErrors: [{ code: 91 }] }));
  await assert.rejects(store.recordDiscoveries([{ id: '7', code: 'code' }]), /bulk write failed/);
});

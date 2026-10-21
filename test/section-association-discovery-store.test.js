'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSectionAssociationStore } = require('../src/sectionAssociations/store');

function fakeMongo(initial = [], clock = () => 1000) {
  const rows = new Map(initial.map(row => [`${row.namespace}:${row.associationOrgUnitId}`, { ...row }]));
  const queries = [];
  const writes = [];
  let failBulk = null;
  let raceRow = null;
  function matches(row, filter = {}) {
    return Object.entries(filter).every(([key, expected]) => {
      if (key === '$or') return expected.some(part => matches(row, part));
      const actual = row[key];
      if (expected && typeof expected === 'object' && !(expected instanceof Date) && !(expected instanceof RegExp)) {
        if ('$in' in expected && !expected.$in.map(String).includes(String(actual))) return false;
        if ('$ne' in expected && actual === expected.$ne) return false;
        if ('$exists' in expected && (actual !== undefined) !== expected.$exists) return false;
        if ('$lte' in expected && !(actual instanceof Date ? actual.getTime() <= expected.$lte.getTime() : actual <= expected.$lte)) return false;
        if ('$gt' in expected && !(actual > expected.$gt)) return false;
      } else if (expected instanceof RegExp ? !expected.test(String(actual || '')) : actual !== expected) return false;
      return true;
    });
  }
  function applyUpdate(row, update, inserting = false) {
    Object.assign(row, update.$set || {});
    if (inserting) Object.assign(row, update.$setOnInsert || {});
    for (const key of Object.keys(update.$unset || {})) delete row[key];
  }
  const associations = {
    async createIndex() {},
    find(filter, options = {}) {
      const ids = filter.associationOrgUnitId?.$in;
      queries.push(ids?.length ?? null);
      let limit = Infinity; let sort = null;
      const cursor = { sort(value) { sort = value; return cursor; }, limit(value) { limit = value; return cursor; },
        async toArray() {
          let result = [...rows.values()].filter(row => matches(row, filter));
          if (sort) { const [[field, direction]] = Object.entries(sort); result.sort((a,b) => direction * ((a[field]?.getTime?.() ?? a[field] ?? '') > (b[field]?.getTime?.() ?? b[field] ?? '') ? 1 : -1)); }
          return result.slice(0, limit).map(row => options.projection ? Object.fromEntries(Object.keys(options.projection).filter(key => options.projection[key] && row[key] !== undefined).map(key => [key, row[key]])) : { ...row });
        } };
      return cursor;
    },
    async findOne(filter) { const row = [...rows.values()].find(row => matches(row, filter)); return row ? { ...row } : null; },
    async countDocuments(filter) { return [...rows.values()].filter(row => matches(row, filter)).length; },
    async updateOne(filter, update, options = {}) {
      const row = [...rows.values()].find(row => matches(row, filter));
      if (row) { applyUpdate(row, update); return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 }; }
      if (options.upsert) {
        const key = `${filter.namespace}:${filter.associationOrgUnitId}`;
        if (rows.has(key)) throw Object.assign(new Error('duplicate key'), { code: 11000 });
        const inserted = { ...filter }; applyUpdate(inserted, update, true); rows.set(key, inserted); return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
      }
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
    },
    async updateMany(filter, update) { let matchedCount = 0; for (const row of rows.values()) if (matches(row, filter)) { applyUpdate(row, update); matchedCount++; } return { matchedCount, modifiedCount: matchedCount }; },
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
        const existing = [...rows.values()].find(row => matches(row, updateOne.filter));
        if (existing) { applyUpdate(existing, updateOne.update); matchedCount++; }
        else if (updateOne.upsert) { const inserted = { ...updateOne.filter }; applyUpdate(inserted, updateOne.update, true); rows.set(`${inserted.namespace}:${inserted.associationOrgUnitId}`, inserted); upsertedCount++; }
      }
      return { upsertedCount, matchedCount };
    }
  };
  const client = { db() { return { collection(name) { return name === 'section_associations' ? associations : { async createIndex() {} }; } }; } };
  return { store: createSectionAssociationStore({ namespace: 'tenant', mongoClient: client, now: clock }), rows, queries, writes,
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

test('reconciliation attempts do not advance discovery timestamps', async () => {
  let time = 1000;
  const { store, rows } = fakeMongo([{ namespace: 'tenant', associationOrgUnitId: '9', associationCode: '002366-01-2602-I0001',
    firstSeenAt: new Date(10), lastSeenAt: new Date(20), status: 'pending' }], () => time);
  time = 2000;
  await store.record('9', { status: 'pending', lastCheckedAt: new Date(time) });
  assert.equal(rows.get('tenant:9').lastSeenAt.getTime(), 20);
  time = 3000;
  await store.recordDiscovery('9', '002366-01-2602-I0001');
  assert.equal(rows.get('tenant:9').lastSeenAt.getTime(), 3000);
});

test('missing confirmation requires a later 30-minute discovery covering the stored period and exact ID', async () => {
  const firstSeen = new Date('2026-10-20T12:00:00Z');
  const rows = [
    { namespace: 'tenant', associationOrgUnitId: '11', associationCode: '002366-01-2602-I0001', status: 'pending', missingObservedAt: firstSeen },
    { namespace: 'tenant', associationOrgUnitId: '12', associationCode: '002366-01-2601-I0001', status: 'pending', missingObservedAt: firstSeen },
    { namespace: 'tenant', associationOrgUnitId: '13', associationCode: '002366-01-2602-I0001', status: 'pending', missingObservedAt: firstSeen }
  ];
  let time = firstSeen.getTime(); const { store, rows: stored } = fakeMongo(rows, () => time); const confirmed = [];
  assert.equal(await store.recordPotentialMissing('11', firstSeen), false);
  assert.equal(stored.get('tenant:11').missingObservedAt.getTime(), firstSeen.getTime());
  let discoveryAt = new Date(firstSeen.getTime() + 29 * 60 * 1000);
  assert.deepEqual(await store.confirmMissing({ periods: ['2602'], discoveredIds: [], discoveryAt }), { confirmed: 0 });
  discoveryAt = new Date(firstSeen.getTime() + 31 * 60 * 1000);
  assert.deepEqual(await store.confirmMissing({ periods: ['2701'], discoveredIds: [], discoveryAt }), { confirmed: 0 });
  const result = await store.confirmMissing({ periods: ['2602'], discoveredIds: ['13'], discoveryAt,
    execution: { executionId: 'missing-run', source: 'automatic' }, recordAudit: async row => confirmed.push(row),
    onConfirmed: row => confirmed.push(row) });
  assert.deepEqual(result, { confirmed: 1 });
  assert.equal(stored.get('tenant:11').status, 'missing');
  assert.equal(stored.get('tenant:11').missingDiscoveryScope, '2602');
  assert.equal(stored.get('tenant:12').status, 'pending');
  assert.equal(stored.get('tenant:13').status, 'pending');
  assert.equal(stored.get('tenant:13').missingObservedAt, undefined);
  assert.equal(confirmed.filter(row => row.kind === 'exception' && row.category === 'missing-confirmed').length, 1);
  assert.equal(confirmed.filter(row => row.associationOrgUnitId === '11').length, 1);
});

test('broad discovery confirms across periods; same-ID rediscovery restores while a new ID stays separate', async () => {
  const old = new Date('2026-10-20T12:00:00Z'); const at = new Date(old.getTime() + 31 * 60000);
  const { store, rows } = fakeMongo([{ namespace: 'tenant', associationOrgUnitId: '21', associationCode: '002366-01-2602-I0001',
    status: 'pending', missingObservedAt: old }, { namespace: 'tenant', associationOrgUnitId: '22', associationCode: '002366-01-2602-I0001',
    status: 'missing', missingObservedAt: old, missingConfirmedAt: at }]);
  await store.confirmMissing({ broad: true, discoveredIds: [], discoveryAt: at });
  assert.equal(rows.get('tenant:21').status, 'missing');
  assert.deepEqual(await store.recordDiscoveries([{ id: '22', code: '002366-01-2602-I0001' }, { id: '23', code: '002366-01-2602-I0001' }],
    { onRestored: item => assert.equal(item.id, '22') }), { newlyRecorded: 1, alreadyKnown: 1 });
  assert.equal(rows.get('tenant:22').status, 'pending');
  assert.equal(rows.get('tenant:22').missingObservedAt, undefined);
  assert.equal(rows.get('tenant:23').status, 'pending');
  assert.notEqual(rows.get('tenant:22').associationOrgUnitId, rows.get('tenant:23').associationOrgUnitId);
});

test('raw successful discovery IDs clear observations and restore known missing IDs even if the returned code is invalid', async () => {
  const observedAt = new Date('2026-10-20T12:00:00Z'); const restored = [];
  const { store, rows } = fakeMongo([
    { namespace: 'tenant', associationOrgUnitId: '24', associationCode: '002366-01-2602-I0001', status: 'missing', missingObservedAt: observedAt },
    { namespace: 'tenant', associationOrgUnitId: '25', associationCode: '002366-01-2602-I0001', status: 'pending', missingObservedAt: observedAt }
  ]);
  assert.deepEqual(await store.recordDiscoveries([], { observedIds: ['24', '25'], onRestored: row => restored.push(row.id) }),
    { newlyRecorded: 0, alreadyKnown: 0 });
  assert.equal(rows.get('tenant:24').status, 'pending');
  assert.equal(rows.get('tenant:24').missingObservedAt, undefined);
  assert.equal(rows.get('tenant:25').missingObservedAt, undefined);
  assert.deepEqual(restored, ['24']);
});

test('confirmed-missing records stay out of fast and recovery work selection', async () => {
  const old = new Date('2020-01-01T00:00:00Z');
  const { store } = fakeMongo([{ namespace: 'tenant', associationOrgUnitId: '31', associationCode: '002366-01-2602-I0001',
    status: 'missing', baseline: true, missingObservedAt: old, missingConfirmedAt: old }]);
  const options = { limit: 10, stabilityCutoff: new Date(), blockedBefore: new Date(), includeCompletedReverification: true, reverifyBefore: new Date() };
  assert.deepEqual(await store.listFastWork(options), []);
  assert.deepEqual(await store.listRecoveryWork(options), []);
  assert.equal(await store.countHistoricalBacklog(), 0);
  assert.equal(await store.countRecoveryWork(options), 0);
});

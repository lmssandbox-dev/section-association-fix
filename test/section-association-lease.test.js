'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSectionAssociationStore } = require('../src/sectionAssociations/store');
const { runSectionAssociationCron } = require('../src/sectionAssociations/cron');
const { main: runCronEntrypoint } = require('../scripts/run-section-association');

function memoryMongo(nowRef) {
  const documents = new Map();
  const meta = {
    async createIndex() {},
    async findOneAndUpdate(filter, update) {
      let doc = documents.get(filter._id);
      const eligible = !doc || !doc.leaseUntil || doc.leaseUntil.getTime() <= filter.$or[0].leaseUntil.$lte.getTime();
      if (!eligible) return { value: null };
      const inserted = !doc;
      if (inserted) { doc = { _id: filter._id }; documents.set(filter._id, doc); }
      Object.assign(doc, structuredClone(update.$set));
      if (inserted) Object.assign(doc, structuredClone(update.$setOnInsert));
      return { value: structuredClone(doc) };
    },
    async updateOne(filter, update) {
      const doc = documents.get(filter._id);
      const matches = doc && doc.leaseToken === filter.leaseToken &&
        (!filter.leaseUntil || doc.leaseUntil.getTime() > filter.leaseUntil.$gt.getTime());
      if (!matches) return { matchedCount: 0, modifiedCount: 0 };
      if (update.$set) Object.assign(doc, structuredClone(update.$set));
      if (update.$unset) for (const key of Object.keys(update.$unset)) delete doc[key];
      return { matchedCount: 1, modifiedCount: 1 };
    },
    async findOne(filter) { return structuredClone(documents.get(filter._id) || null); }
  };
  const associations = { async createIndex() {} };
  const mongoClient = { db: () => ({ collection(name) { return name === 'section_association_meta' ? meta : associations; } }) };
  return { documents, store: createSectionAssociationStore({ namespace: 'tenant-hash', mongoClient, now: () => nowRef.value }) };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('successful cron releases its shared lease promptly', async () => {
  const now = { value: 1000 };
  const { store } = memoryMongo(now);
  const logs = [];
  const result = await runSectionAssociationCron({ service: { async fastTick() { return { status: 'completed' }; }, async recoveryTick() {} },
    store, recoveryIntervalHours: 4, logger: { info: line => logs.push(line), warn: line => logs.push(line), error: line => logs.push(line) },
    setIntervalFn: () => 1, clearIntervalFn() {} });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(await store.cronLeaseStatus(), { leaseKey: 'cron:tenant-hash', owner: 'unknown', acquiredAt: null, expiresAt: null, expired: true });
  assert.ok(logs.includes('[section-association] lease acquired owner=cron expiresAt=1970-01-01T00:10:01.000Z'));
  assert.ok(logs.includes('[section-association] lease released owner=cron'));
  assert.ok(await store.acquireCronLease(600000, 'cron'));
});

test('failed cron also awaits lease release', async () => {
  const { store } = memoryMongo({ value: 1000 });
  const result = await runSectionAssociationCron({ service: { async fastTick() { return { status: 'failed' }; } }, store,
    recoveryIntervalHours: 4, logger: { info() {}, warn() {}, error() {} }, setIntervalFn: () => 1, clearIntervalFn() {} });
  assert.equal(result.exitCode, 1);
  assert.equal((await store.cronLeaseStatus()).expired, true);
});

test('concurrent cron runs cannot overlap; expired leases can be reclaimed but active leases cannot', async () => {
  const now = { value: 1000 };
  const { store } = memoryMongo(now);
  const started = deferred();
  const finish = deferred();
  const cronRun = runSectionAssociationCron({ service: { async fastTick() { started.resolve(); await finish.promise; return { status: 'completed' }; } },
    store, recoveryIntervalHours: 4, logger: { info() {}, warn() {}, error() {} }, setIntervalFn: () => 1, clearIntervalFn() {} });
  await started.promise;
  assert.equal(await store.acquireCronLease(600000, 'cron'), null);
  finish.resolve();
  await cronRun;
  assert.ok(await store.acquireCronLease(600000, 'cron'));

  const stale = memoryMongo(now);
  assert.ok(await stale.store.acquireCronLease(500, 'cron'));
  now.value += 501;
  const replacement = await stale.store.acquireCronLease(600000, 'cron');
  assert.ok(replacement);
  assert.equal((await stale.store.cronLeaseStatus()).owner, 'cron');
});

test('cron entrypoint waits for run finalization and lease release before closing runtime', async () => {
  const events = [];
  const release = deferred();
  const env = { DB_MONGODB_URL: 'mongodb://user:password@localhost/section_assoc', BS_URL: 'https://tenant.example',
    BS_OAUTH2_CLIENT_ID: 'client', BS_OAUTH2_PRIVATE_KEY: 'private-key', BS_OAUTH2_KEY_ID: 'key',
    BS_OAUTH2_TOKEN_ENDPOINT: 'https://auth.brightspace.com/core/connect/token',
    BS_OAUTH2_SCOPES: 'organizations:organization:read orgunits:course:update', D2L_API_LP_VERSION: '1.53',
    SECTION_ASSOCIATION_FIX_DRY_RUN: 'true' };
  const running = runCronEntrypoint(env, {
    createRuntime: () => ({ service: {}, store: {}, async close() { events.push('runtime-closed'); } }),
    async runCron() { events.push('cron-started'); await release.promise; events.push('lease-released'); return { exitCode: 0 }; }
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['cron-started']);
  release.resolve();
  assert.equal(await running, 0);
  assert.deepEqual(events, ['cron-started', 'lease-released', 'runtime-closed']);
});

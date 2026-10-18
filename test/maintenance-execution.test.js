'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runSectionAssociationCron } = require('../src/sectionAssociations/cron');
const { startSectionAssociationScheduler } = require('../src/sectionAssociations/scheduler');
const { main: runOneShot, maintenanceSource } = require('../scripts/run-section-association');

function memoryExecutionStore() {
  const summaries = [];
  return { summaries,
    async saveMaintenanceExecution(summary) { summaries.push(summary); return true; },
    async acquireCronLease() { return 'lease'; },
    async releaseCronLease() { return { matchedCount: 1 }; },
    async cronLeaseStatus() { return { owner: 'cron', expiresAt: new Date(1000), expired: false }; },
    async recoveryDue() { return false; }
  };
}

const stats = { associationsChecked: 3, associationsAlreadyCompliant: 1, correctionsApplied: 1,
  errors: 1, remainingHistoricalBacklog: 2 };

test('one-shot source follows the actual invocation flag and defaults to scheduled automatic', () => {
  assert.equal(maintenanceSource(['node', 'scripts/run-section-association.js']), 'automatic');
  assert.equal(maintenanceSource(['node', 'scripts/run-section-association.js', '--manual']), 'manual');
});

test('internal automatic scheduler persists compact association-level counters', async () => {
  const store = memoryExecutionStore();
  const scheduler = startSectionAssociationScheduler({ store, fastIntervalMinutes: 15, recoveryIntervalHours: 4,
    service: { async fastTick() { return { status: 'completed', ...stats }; }, async recoveryTick() { return { status: 'completed', ...stats }; } },
    setIntervalFn: () => 1, logger: { info() {}, warn() {}, error() {} } });
  await scheduler.initialFastCycle;
  assert.equal(store.summaries.length, 1);
  assert.equal(store.summaries[0].source, 'automatic');
  assert.equal(store.summaries[0].status, 'completed');
  assert.equal(store.summaries[0].associationsChecked, 3);
  assert.equal(store.summaries[0].alreadyCompliant, 1);
  assert.equal(store.summaries[0].correctionsApplied, 1);
  assert.equal(store.summaries[0].errors, 1);
  assert.deepEqual(store.summaries[0].coverage, { type: 'bounded-cycle', remainingHistoricalBacklog: 2 });
});

test('cron persists failed automatic outcome and only counters returned by the worker', async () => {
  const store = memoryExecutionStore();
  const result = await runSectionAssociationCron({ store, service: {
    async fastTick() { return { status: 'failed', associationsChecked: 2, associationsAlreadyCompliant: 0,
      correctionsApplied: 1, errors: 1 }; }
  }, recoveryIntervalHours: 4, now: () => 1000, setIntervalFn: () => 1, clearIntervalFn() {},
  logger: { info() {}, warn() {}, error() {} } });
  assert.deepEqual(result, { status: 'failed', exitCode: 1 });
  assert.equal(store.summaries.length, 1);
  assert.equal(store.summaries[0].source, 'automatic');
  assert.equal(store.summaries[0].status, 'failed');
  assert.equal(store.summaries[0].associationsChecked, 2);
  assert.equal(store.summaries[0].correctionsApplied, 1);
  assert.equal('coverage' in store.summaries[0], false);
});

test('cron summary combines period and activity evidence from fast and recovery passes', async () => {
  const store = memoryExecutionStore();
  store.recoveryDue = async () => true;
  await runSectionAssociationCron({ store, service: {
    async fastTick() { return { status:'completed', ...stats, discoveryPeriods:{current:'2602',previous:'2601'},
      discoveryActivities:{currentPrevious:true,historical:true} }; },
    async recoveryTick() { return { status:'completed', ...stats, discoveryActivities:{reverification:true} }; }
  }, recoveryIntervalHours:4, now:()=>1000, setIntervalFn:()=>1, clearIntervalFn(){},
  logger:{info(){},warn(){},error(){}} });
  assert.deepEqual(store.summaries[0].discoveryPeriods,{current:'2602',previous:'2601'});
  assert.deepEqual(store.summaries[0].discoveryActivities,{currentPrevious:true,historical:true,reverification:true});
});

test('summary omits period and activity metadata when the worker did not record completed discovery evidence', async () => {
  const store = memoryExecutionStore();
  await runSectionAssociationCron({ store, service: { async fastTick(){ return {status:'failed',errors:1}; } },
    recoveryIntervalHours:4, now:()=>1000, setIntervalFn:()=>1, clearIntervalFn(){}, logger:{info(){},warn(){},error(){}} });
  assert.equal('discoveryPeriods' in store.summaries[0],false);
  assert.equal('discoveryActivities' in store.summaries[0],false);
});

test('manual one-shot invocation passes manual source into the shared persisted execution path', async () => {
  const store = memoryExecutionStore();
  const env = { DB_MONGODB_URL: 'mongodb://localhost:27017/section_association',
    BS_URL: 'https://tenant.brightspace.com', BS_OAUTH2_CLIENT_ID: 'client',
    BS_OAUTH2_PRIVATE_KEY: 'private-key', BS_OAUTH2_KEY_ID: 'key-id',
    BS_OAUTH2_TOKEN_ENDPOINT: 'https://auth.brightspace.com/core/connect/token',
    BS_OAUTH2_SCOPES: 'organizations:organization:read orgunits:course:update',
    D2L_API_LP_VERSION: '1.53', SECTION_ASSOCIATION_FIX_DRY_RUN: 'true' };
  const code = await runOneShot(env, { argv: ['node', 'scripts/run-section-association.js', '--manual'],
    createRuntime() { return { service: { async fastTick() { return { status: 'completed', ...stats }; } }, store,
      recoveryIntervalHours: 4, maxReconciliationsPerRun: 50, async close() {} }; },
    runCron: runSectionAssociationCron });
  assert.equal(code, 0);
  assert.equal(store.summaries.length, 1);
  assert.equal(store.summaries[0].source, 'manual');
  assert.equal(store.summaries[0].status, 'completed');
  assert.equal(store.summaries[0].correctionsApplied, 1);
});

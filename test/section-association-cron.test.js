'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runSectionAssociationCron } = require('../src/sectionAssociations/cron');

function setup({ fastStatus = 'completed', recoveryStatus = 'completed', due = false, locked = false } = {}) {
  let lock = locked;
  const calls = [];
  const logs = [];
  const service = {
    async fastTick() { calls.push('fast'); return { status: fastStatus }; },
    async recoveryTick() { calls.push('recovery'); return { status: recoveryStatus }; }
  };
  const store = {
    async acquireCronLease() { if (lock) return null; lock = true; calls.push('acquire'); return 'lease'; },
    async renewCronLease() { calls.push('renew'); },
    async releaseCronLease() { calls.push('release'); lock = false; },
    async recoveryDue() { calls.push('due'); return due; },
    async markRecoveryCompleted() { calls.push('mark'); }
  };
  const run = () => runSectionAssociationCron({ service, store, recoveryIntervalHours: 4,
    logger: { info: value => logs.push(value), warn: value => logs.push(value), error: value => logs.push(value) },
    setIntervalFn(callback, ms) { return { callback, ms }; }, clearIntervalFn() {} });
  return { run, calls, logs, store, service };
}

test('cron runs one fast cycle, runs due recovery, persists completion, and exits successfully', async () => {
  const h = setup({ due: true });
  const result = await h.run();
  assert.deepEqual(result, { status: 'completed', exitCode: 0 });
  assert.deepEqual(h.calls, ['acquire', 'fast', 'due', 'recovery', 'mark', 'release']);
  assert.ok(h.logs.includes('[section-association] cron started'));
  assert.ok(h.logs.includes('[section-association] recovery due due=true'));
  assert.ok(h.logs.some(line => /^\[section-association\] cron completed status=completed elapsedMs=\d+$/.test(line)));
});

test('recovery due state persists across separate cron invocations', async () => {
  let lastRecoveryAt = null;
  const calls = [];
  const store = {
    async acquireCronLease() { return 'lease'; }, async renewCronLease() {}, async releaseCronLease() {},
    async recoveryDue(interval) { calls.push(['due', interval]); return lastRecoveryAt === null; },
    async markRecoveryCompleted() { calls.push(['mark']); lastRecoveryAt = 1; }
  };
  const service = { async fastTick() { calls.push(['fast']); return { status: 'completed' }; },
    async recoveryTick() { calls.push(['recovery']); return { status: 'completed' }; } };
  const options = { service, store, recoveryIntervalHours: 4, logger: { info() {}, warn() {}, error() {} }, now: () => 10 };
  assert.equal((await runSectionAssociationCron(options)).exitCode, 0);
  assert.equal((await runSectionAssociationCron(options)).exitCode, 0);
  assert.equal(calls.filter(([event]) => event === 'recovery').length, 1);
  assert.equal(calls.filter(([event]) => event === 'mark').length, 1);
});

test('failed fast cycle returns nonzero and leaves recovery due for a later invocation', async () => {
  const h = setup({ fastStatus: 'failed', due: true });
  const result = await h.run();
  assert.deepEqual(result, { status: 'failed', exitCode: 1 });
  assert.deepEqual(h.calls, ['acquire', 'fast', 'release']);
  assert.ok(h.logs.some(line => line.startsWith('[section-association] cron failed phase=discovery')));
});

test('overlapping cron invocation skips safely without running another cycle', async () => {
  const h = setup({ locked: true });
  const result = await h.run();
  assert.deepEqual(result, { status: 'skipped', exitCode: 0 });
  assert.deepEqual(h.calls, []);
  assert.ok(h.logs.includes('[section-association] cron skipped reason=already-running'));
});

test('recovery failure does not advance persisted recovery state', async () => {
  const h = setup({ due: true, recoveryStatus: 'failed' });
  assert.deepEqual(await h.run(), { status: 'failed', exitCode: 1 });
  assert.equal(h.calls.includes('mark'), false);
});

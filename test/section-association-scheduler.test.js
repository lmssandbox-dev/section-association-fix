'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startSectionAssociationScheduler } = require('../src/sectionAssociations/scheduler');

function harness(service) {
  const intervals = [];
  const logs = [];
  const scheduler = startSectionAssociationScheduler({
    service,
    fastIntervalMinutes: 15,
    recoveryIntervalHours: 4,
    setIntervalFn(callback, milliseconds) {
      const timer = { callback, milliseconds, unrefCalled: false, unref() { this.unrefCalled = true; } };
      intervals.push(timer);
      return timer;
    },
    logger: {
      info(message) { logs.push(message); },
      warn(message) { logs.push(message); },
      error(message) { logs.push(message); }
    }
  });
  return { scheduler, intervals, logs };
}

test('scheduler runs fast immediately, then on each configured interval tick', async () => {
  let fastCalls = 0;
  const { scheduler, intervals, logs } = harness({
    async fastTick() { fastCalls++; },
    async recoveryTick() {}
  });
  assert.equal(intervals[0].milliseconds, 15 * 60000);
  assert.equal(intervals[1].milliseconds, 4 * 60 * 60000);
  assert.equal(intervals[0].unrefCalled, false);
  assert.equal(intervals[1].unrefCalled, false);
  assert.equal(logs[0], '[section-association] scheduler started fastIntervalMinutes=15 recoveryIntervalHours=4');
  await scheduler.initialFastCycle;
  assert.equal(fastCalls, 1);
  await intervals[0].callback();
  await intervals[0].callback();
  assert.equal(fastCalls, 3);
});

test('a rejected fast cycle is contained and later scheduled cycles continue', async () => {
  let fastCalls = 0;
  const { intervals, logs, scheduler } = harness({
    async fastTick() { if (++fastCalls === 1) throw new Error('private upstream details'); },
    async recoveryTick() {}
  });
  await scheduler.initialFastCycle;
  await intervals[0].callback();
  await intervals[0].callback();
  assert.equal(fastCalls, 3);
  assert.ok(logs.some(line => /^\[section-association\] fast cycle failed phase=scheduler elapsedMs=\d+$/.test(line)));
  assert.equal(logs.some(line => line.includes('private upstream details')), false);
});

test('recovery timer is independent of fast timer and uses hours-to-milliseconds conversion', async () => {
  let fastCalls = 0;
  let recoveryCalls = 0;
  const { intervals, scheduler } = harness({
    async fastTick() { fastCalls++; },
    async recoveryTick() { recoveryCalls++; }
  });
  await scheduler.initialFastCycle;
  await intervals[1].callback();
  assert.equal(fastCalls, 1);
  assert.equal(recoveryCalls, 1);
});

test('overlapping fast cycles are skipped until the active cycle finishes', async () => {
  let fastCalls = 0;
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const { intervals, logs, scheduler } = harness({
    async fastTick() { fastCalls++; if (fastCalls === 1) await pending; },
    async recoveryTick() {}
  });
  assert.equal(fastCalls, 1);
  const overlap = await intervals[0].callback();
  assert.deepEqual(overlap, { skipped: true });
  assert.ok(logs.includes('[section-association] fast cycle skipped reason=already-running'));
  release();
  await scheduler.initialFastCycle;
  await intervals[0].callback();
  assert.equal(fastCalls, 2);
});

test('internal scheduled cycles use and release the shared Mongo lease', async () => {
  const calls = [];
  const scheduler = startSectionAssociationScheduler({
    service: { async fastTick() { calls.push('fast'); return { status: 'completed' }; }, async recoveryTick() {} },
    store: { async acquireCronLease(_ms, owner) { calls.push(`acquire:${owner}`); return 'lease'; },
      async renewCronLease() { calls.push('renew'); }, async releaseCronLease(token) { calls.push(`release:${token}`); } },
    fastIntervalMinutes: 15, recoveryIntervalHours: 4,
    setIntervalFn(callback, milliseconds) { return { callback, milliseconds }; }, clearIntervalFn() {},
    logger: { info() {}, warn() {}, error() {} }
  });
  await scheduler.initialFastCycle;
  assert.deepEqual(calls, ['acquire:internal', 'fast', 'release:lease']);
});

test('automatic API Health Check failure stays isolated from the internal reconciliation tick', async () => {
  let fastCalls=0,healthCalls=0;
  const {scheduler}= (()=>{
    const scheduler=startSectionAssociationScheduler({service:{async fastTick(){fastCalls++;return{status:'completed'}},async recoveryTick(){}},
      apiHealthService:{async runIfDue(){healthCalls++;throw new Error('private health failure')}},fastIntervalMinutes:15,recoveryIntervalHours:4,
      setIntervalFn(callback,milliseconds){return{callback,milliseconds}},clearIntervalFn(){},logger:{info(){},warn(){},error(){}}});
    return{scheduler};
  })();
  await scheduler.initialFastCycle;await new Promise(resolve=>setImmediate(resolve));
  assert.equal(fastCalls,1);assert.equal(healthCalls,1);assert.equal(scheduler.status().state,'idle');
});

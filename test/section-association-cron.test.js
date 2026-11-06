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

test('cron health assessment failure does not fail or change reconciliation processing', async()=>{
  const h=setup();let checks=0;
  const result=await runSectionAssociationCron({service:h.service,store:h.store,recoveryIntervalHours:4,
    apiHealthService:{async runIfDue(){checks++;throw new Error('private health diagnostic')}},
    logger:{info(){},warn(){},error(){}},setIntervalFn(callback,ms){return{callback,ms}},clearIntervalFn(){}});
  assert.deepEqual(result,{status:'completed',exitCode:0});assert.equal(checks,1);
  assert.deepEqual(h.calls,['acquire','fast','due','release']);
});

test('manual execution records manual history and transitions only after acquiring the shared lease', async()=>{
  const events=[];let held=false;let summary;
  const store={async acquireCronLease(){if(held)return null;held=true;events.push('lease');return'token'},
    async markManualExecutionRunning(id){events.push(['running',id]);return true},async renewCronLease(){},
    async releaseCronLease(){held=false},async saveMaintenanceExecution(value){summary=value},
    async finishManualExecution(id,status){events.push([status,id])},async recoveryDue(){return false}};
  const result=await runSectionAssociationCron({service:{async fastTick({execution}){events.push(execution.source);return{status:'completed',associationsChecked:2,associationsAlreadyCompliant:2,correctionsApplied:0,errors:0}},async recoveryTick(){}},
    store,recoveryIntervalHours:4,source:'manual',manualRequestId:'request-1',logger:{info(){},warn(){},error(){}},
    setIntervalFn(){return 1},clearIntervalFn(){}});
  assert.equal(result.status,'completed');assert.deepEqual(events.filter(Array.isArray),[['running','request-1'],['completed','request-1']]);
  assert.equal(summary.source,'manual');assert.equal(summary.status,'completed');
});

test('automatic cron recovers an interrupted manual request with manual history attribution',async()=>{
  const events=[];let running;
  const store={async getManualExecutionRequest(){return{requestId:'request-recovered',status:'running'}},
    async acquireCronLease(){return'lease'},async markManualExecutionRunning(id){running=id;return true},
    async renewCronLease(){},async releaseCronLease(){},async recoveryDue(){return false},
    async saveMaintenanceExecution(summary){events.push(summary.source)},async finishManualExecution(id,status){events.push(status)}};
  const result=await runSectionAssociationCron({service:{async fastTick(){return{status:'completed',associationsChecked:0,associationsAlreadyCompliant:0,correctionsApplied:0,errors:0}},async recoveryTick(){}},
    store,recoveryIntervalHours:4,logger:{info(){},warn(){},error(){}},setIntervalFn(){return 1},clearIntervalFn(){}});
  assert.equal(result.status,'completed');assert.equal(running,'request-recovered');assert.deepEqual(events,['manual','completed']);
});

test('manual request stays requested when the automatic worker already owns the shared lease',async()=>{
  let runningCalls=0,finishCalls=0;
  const store={async acquireCronLease(){return null},async cronLeaseStatus(){return{owner:'cron',expiresAt:new Date(1)}} ,
    async markManualExecutionRunning(){runningCalls++;return true},async finishManualExecution(){finishCalls++},
    async getManualExecutionRequest(){return{requestId:'waiting',status:'requested'}}};
  const result=await runSectionAssociationCron({service:{async fastTick(){throw new Error('must not run')}},store,recoveryIntervalHours:4,
    manualRequestId:'waiting',source:'manual',logger:{info(){},warn(){},error(){}},setIntervalFn(){return 1},clearIntervalFn(){}});
  assert.equal(result.status,'skipped');assert.equal(runningCalls,0);assert.equal(finishCalls,0);
});

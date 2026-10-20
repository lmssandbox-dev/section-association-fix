'use strict';

const { logEvent, safeErrorFields } = require('./log');
const { startMaintenanceExecution, buildMaintenanceExecutionSummary, persistMaintenanceExecution } = require('./executionSummary');

function startSectionAssociationScheduler({ service, store, apiHealthService, fastIntervalMinutes, recoveryIntervalHours,
  setIntervalFn = setInterval, clearIntervalFn = clearInterval, logger = console }) {
  const fastIntervalMs = fastIntervalMinutes * 60000;
  const recoveryIntervalMs = recoveryIntervalHours * 60 * 60000;
  let fastRunning = false;
  let recoveryRunning = false;
  let latestExecution = null;

  async function withSharedLease(operation) {
    if (!store?.acquireCronLease) return operation();
    const leaseMs = 10 * 60 * 1000;
    const token = await store.acquireCronLease(leaseMs, 'internal');
    if (!token) {
      logEvent(logger, 'warn', 'scheduled cycle skipped', { reason: 'lease-unavailable' });
      return { status: 'skipped', skipped: true };
    }
    let renewalFailed = false;
    let renewalRunning = false;
    const heartbeat = setIntervalFn(() => {
      if (renewalRunning) return;
      renewalRunning = true;
      void store.renewCronLease(token, leaseMs).catch(() => { renewalFailed = true; })
        .finally(() => { renewalRunning = false; });
    }, 60000);
    try {
      const result = await operation();
      if (renewalFailed) throw Object.assign(new Error('Scheduled worker lease renewal failed.'), { code: 'CRON_LEASE_RENEWAL_FAILED' });
      return result;
    } finally {
      clearIntervalFn(heartbeat);
      await store.releaseCronLease(token);
    }
  }

  logEvent(logger, 'info', 'scheduler started', {
    fastIntervalMinutes,
    recoveryIntervalHours
  });

  async function runFast() {
    if (fastRunning) {
      logEvent(logger, 'warn', 'fast cycle skipped', { reason: 'already-running' });
      return { skipped: true };
    }
    fastRunning = true;
    const startedAt = Date.now();
    const execution = startMaintenanceExecution('automatic');
    let result;
    try {
      result = await withSharedLease(() => service.fastTick({ execution }));
      latestExecution = { kind: 'Fast cycle', completedAt: new Date().toISOString(), result };
      return result;
    }
    catch (error) {
      const elapsedMs = Math.max(0, Date.now() - startedAt);
      logEvent(logger, 'error', 'fast cycle failed', safeErrorFields(error, {
        phase: 'scheduler', elapsedMs
      }));
      logEvent(logger, 'info', 'fast cycle finished', { status: 'failed', elapsedMs });
      latestExecution = { kind: 'Fast cycle', completedAt: new Date().toISOString(), result: { status: 'failed' } };
      result = { failed: true, errors: 1 };
      return { failed: true };
    } finally {
      if (store) await persistMaintenanceExecution(store, buildMaintenanceExecutionSummary(execution,
        { status: result?.status || (result?.failed ? 'failed' : 'completed'), results: result ? [result] : [] }), logger);
      fastRunning = false;
      if (apiHealthService?.runIfDue) void Promise.resolve().then(() => apiHealthService.runIfDue()).catch(() => null);
    }
  }

  async function runRecovery() {
    if (recoveryRunning) {
      logEvent(logger, 'warn', 'recovery cycle skipped', { reason: 'already-running' });
      return { skipped: true };
    }
    recoveryRunning = true;
    const startedAt = Date.now();
    const execution = startMaintenanceExecution('automatic');
    let result;
    try {
      result = await withSharedLease(() => service.recoveryTick({ execution }));
      latestExecution = { kind: 'Recovery cycle', completedAt: new Date().toISOString(), result };
      return result;
    }
    catch (error) {
      const elapsedMs = Math.max(0, Date.now() - startedAt);
      logEvent(logger, 'error', 'recovery cycle failed', safeErrorFields(error, {
        phase: 'scheduler', elapsedMs
      }));
      logEvent(logger, 'info', 'recovery cycle finished', { status: 'failed', elapsedMs });
      latestExecution = { kind: 'Recovery cycle', completedAt: new Date().toISOString(), result: { status: 'failed' } };
      result = { failed: true, errors: 1 };
      return { failed: true };
    } finally {
      if (store) await persistMaintenanceExecution(store, buildMaintenanceExecutionSummary(execution,
        { status: result?.status || (result?.failed ? 'failed' : 'completed'), results: result ? [result] : [] }), logger);
      recoveryRunning = false;
    }
  }

  // Keep referenced interval handles in this scheduler for the life of the service.
  const fastTimer = setIntervalFn(() => runFast(), fastIntervalMs);
  const recoveryTimer = setIntervalFn(() => runRecovery(), recoveryIntervalMs);
  const initialFastCycle = runFast();
  return { fastTimer, recoveryTimer, initialFastCycle, runFast, runRecovery,
    status() { return { state: fastRunning || recoveryRunning ? 'running' :
      latestExecution?.result?.status === 'failed' ? 'error' : 'idle', latestExecution }; } };
}

module.exports = { startSectionAssociationScheduler };

'use strict';

const { logEvent, safeErrorFields } = require('./log');
const { startMaintenanceExecution, buildMaintenanceExecutionSummary, persistMaintenanceExecution } = require('./executionSummary');

async function runSectionAssociationCron({ service, store, recoveryIntervalHours, logger = console,
  now = Date.now, setIntervalFn = setInterval, clearIntervalFn = clearInterval,
  leaseMs = 10 * 60 * 1000, heartbeatMs = 60 * 1000, maxReconciliationsPerRun = 50,
  source = 'automatic', apiHealthService }) {
  const startedAt = now();
  const execution = startMaintenanceExecution(source, now);
  logEvent(logger, 'info', 'cron started');
  let token;
  let heartbeat;
  let heartbeatFailure = false;
  let heartbeatRunning = false;
  let phase = 'database';
  let executionStatus = 'failed';
  let executionErrors = 0;
  const results = [];
  try {
    token = await store.acquireCronLease(leaseMs, 'cron');
    if (!token) {
      executionStatus = 'skipped';
      let lease = {};
      try { lease = safeLeaseFields(await store.cronLeaseStatus()); } catch { /* Preserve the safe skip path. */ }
      logEvent(logger, 'warn', 'lease unavailable', { owner: lease.owner || 'unknown', expiresAt: lease.expiresAt || 'unknown' });
      logEvent(logger, 'warn', 'cron skipped', { reason: 'already-running' });
      return { status: 'skipped', exitCode: 0 };
    }
    let lease = {};
    try { lease = safeLeaseFields(await store.cronLeaseStatus()); } catch { /* Lease acquisition remains valid if diagnostics fail. */ }
    logEvent(logger, 'info', 'lease acquired', { owner: 'cron', expiresAt: lease.expiresAt || 'unknown' });
    heartbeat = setIntervalFn(() => {
      if (heartbeatRunning) return;
      heartbeatRunning = true;
      void store.renewCronLease(token, leaseMs).catch(() => { heartbeatFailure = true; })
        .finally(() => { heartbeatRunning = false; });
    }, heartbeatMs);

    phase = 'discovery';
    const fast = await service.fastTick({ maxReconciliations: maxReconciliationsPerRun, execution });
    results.push(fast);
    if (fast?.status && fast.status !== 'completed') throw Object.assign(new Error('Fast cycle did not complete.'), {
      phase: fast.phase || 'discovery', code: fast.code || 'FAST_CYCLE_FAILED'
    });

    phase = 'database';
    const due = await store.recoveryDue(recoveryIntervalHours * 60 * 60 * 1000);
    logEvent(logger, 'info', 'recovery due', { due });
    if (due) {
      phase = 'discovery';
      const remaining = Math.max(0, maxReconciliationsPerRun - (fast?.processedThisRun || 0));
      const recovery = await service.recoveryTick({ maxReconciliations: remaining, execution,
        discoveryAlreadyCompleted: true });
      results.push(recovery);
      if (recovery?.status && recovery.status !== 'completed') throw Object.assign(new Error('Recovery cycle did not complete.'), {
        phase: recovery.phase || 'discovery', code: recovery.code || 'RECOVERY_CYCLE_FAILED'
      });
      phase = 'database';
      if (recovery?.recoveryComplete !== false) await store.markRecoveryCompleted(token);
    }
    if (heartbeatFailure) throw Object.assign(new Error('Cron lease renewal failed.'), { phase: 'database', code: 'CRON_LEASE_RENEWAL_FAILED' });
    const elapsedMs = Math.max(0, now() - startedAt);
    logEvent(logger, 'info', 'cron completed', { status: 'completed', elapsedMs });
    executionStatus = 'completed';
    return { status: 'completed', exitCode: 0 };
  } catch (error) {
    if (!results.some(result => result?.status === 'failed' && Number.isSafeInteger(result.errors))) executionErrors = 1;
    const elapsedMs = Math.max(0, now() - startedAt);
    logEvent(logger, 'error', 'cron failed', safeErrorFields(error, { phase: error?.phase || phase, elapsedMs }));
    return { status: 'failed', exitCode: 1 };
  } finally {
    if (heartbeat) clearIntervalFn(heartbeat);
    if (token) {
      try {
        const released = await store.releaseCronLease(token);
        if ((released?.matchedCount ?? released?.modifiedCount ?? 1) > 0) logEvent(logger, 'info', 'lease released', { owner: 'cron' });
        else logEvent(logger, 'warn', 'lease release failed', { owner: 'cron', reason: 'lease-token-not-current' });
      } catch (error) {
        const code = /^[A-Z][A-Z0-9_]{0,63}$/.test(String(error?.code || '')) ? error.code : 'LEASE_RELEASE_FAILED';
        logEvent(logger, 'error', 'lease release failed', { owner: 'cron', code });
      }
    }
    await persistMaintenanceExecution(store, buildMaintenanceExecutionSummary(execution,
      { status: executionStatus, results, executionErrors, now }), logger);
    if (apiHealthService?.runIfDue) await Promise.resolve().then(() => apiHealthService.runIfDue()).catch(() => null);
  }
}

function safeLeaseFields(lease) {
  return { owner: lease?.owner === 'cron' ? lease.owner : 'unknown',
    expiresAt: lease?.expiresAt instanceof Date ? lease.expiresAt.toISOString() : null };
}

module.exports = { runSectionAssociationCron };

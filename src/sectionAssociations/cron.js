'use strict';

const { logEvent, safeErrorFields } = require('./log');

async function runSectionAssociationCron({ service, store, recoveryIntervalHours, logger = console,
  now = Date.now, setIntervalFn = setInterval, clearIntervalFn = clearInterval,
  leaseMs = 10 * 60 * 1000, heartbeatMs = 60 * 1000 }) {
  const startedAt = now();
  logEvent(logger, 'info', 'cron started');
  let token;
  let heartbeat;
  let heartbeatFailure = false;
  let heartbeatRunning = false;
  let phase = 'database';
  try {
    token = await store.acquireCronLease(leaseMs);
    if (!token) {
      logEvent(logger, 'warn', 'cron skipped', { reason: 'already-running' });
      return { status: 'skipped', exitCode: 0 };
    }
    heartbeat = setIntervalFn(() => {
      if (heartbeatRunning) return;
      heartbeatRunning = true;
      void store.renewCronLease(token, leaseMs).catch(() => { heartbeatFailure = true; })
        .finally(() => { heartbeatRunning = false; });
    }, heartbeatMs);

    phase = 'discovery';
    const fast = await service.fastTick();
    if (fast?.status && fast.status !== 'completed') throw Object.assign(new Error('Fast cycle did not complete.'), {
      phase: fast.phase || 'discovery', code: fast.code || 'FAST_CYCLE_FAILED'
    });

    phase = 'database';
    const due = await store.recoveryDue(recoveryIntervalHours * 60 * 60 * 1000);
    logEvent(logger, 'info', 'recovery due', { due });
    if (due) {
      phase = 'discovery';
      const recovery = await service.recoveryTick();
      if (recovery?.status && recovery.status !== 'completed') throw Object.assign(new Error('Recovery cycle did not complete.'), {
        phase: recovery.phase || 'discovery', code: recovery.code || 'RECOVERY_CYCLE_FAILED'
      });
      phase = 'database';
      await store.markRecoveryCompleted(token);
    }
    if (heartbeatFailure) throw Object.assign(new Error('Cron lease renewal failed.'), { phase: 'database', code: 'CRON_LEASE_RENEWAL_FAILED' });
    const elapsedMs = Math.max(0, now() - startedAt);
    logEvent(logger, 'info', 'cron completed', { status: 'completed', elapsedMs });
    return { status: 'completed', exitCode: 0 };
  } catch (error) {
    const elapsedMs = Math.max(0, now() - startedAt);
    logEvent(logger, 'error', 'cron failed', safeErrorFields(error, { phase: error?.phase || phase, elapsedMs }));
    return { status: 'failed', exitCode: 1 };
  } finally {
    if (heartbeat) clearIntervalFn(heartbeat);
    if (token) await store.releaseCronLease(token).catch(() => {});
  }
}

module.exports = { runSectionAssociationCron };

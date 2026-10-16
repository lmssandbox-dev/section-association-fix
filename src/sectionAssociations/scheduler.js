'use strict';

const { logEvent, safeErrorFields } = require('./log');

function startSectionAssociationScheduler({ service, fastIntervalMinutes, recoveryIntervalHours,
  setIntervalFn = setInterval, logger = console }) {
  const fastIntervalMs = fastIntervalMinutes * 60000;
  const recoveryIntervalMs = recoveryIntervalHours * 60 * 60000;
  let fastRunning = false;
  let recoveryRunning = false;

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
    try { return await service.fastTick(); }
    catch (error) {
      const elapsedMs = Math.max(0, Date.now() - startedAt);
      logEvent(logger, 'error', 'fast cycle failed', safeErrorFields(error, {
        phase: 'scheduler', elapsedMs
      }));
      logEvent(logger, 'info', 'fast cycle finished', { status: 'failed', elapsedMs });
      return { failed: true };
    } finally { fastRunning = false; }
  }

  async function runRecovery() {
    if (recoveryRunning) {
      logEvent(logger, 'warn', 'recovery cycle skipped', { reason: 'already-running' });
      return { skipped: true };
    }
    recoveryRunning = true;
    const startedAt = Date.now();
    try { return await service.recoveryTick(); }
    catch (error) {
      const elapsedMs = Math.max(0, Date.now() - startedAt);
      logEvent(logger, 'error', 'recovery cycle failed', safeErrorFields(error, {
        phase: 'scheduler', elapsedMs
      }));
      logEvent(logger, 'info', 'recovery cycle finished', { status: 'failed', elapsedMs });
      return { failed: true };
    } finally { recoveryRunning = false; }
  }

  // Keep referenced interval handles in this scheduler for the life of the service.
  const fastTimer = setIntervalFn(() => runFast(), fastIntervalMs);
  const recoveryTimer = setIntervalFn(() => runRecovery(), recoveryIntervalMs);
  const initialFastCycle = runFast();
  return { fastTimer, recoveryTimer, initialFastCycle, runFast, runRecovery };
}

module.exports = { startSectionAssociationScheduler };

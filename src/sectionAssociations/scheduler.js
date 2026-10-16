'use strict';

const { logEvent } = require('./log');

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
    try { return await service.fastTick(); }
    catch {
      logEvent(logger, 'error', 'fast cycle failed', { reason: 'scheduler-error' });
      return { failed: true };
    } finally { fastRunning = false; }
  }

  async function runRecovery() {
    if (recoveryRunning) {
      logEvent(logger, 'warn', 'recovery cycle skipped', { reason: 'already-running' });
      return { skipped: true };
    }
    recoveryRunning = true;
    try { return await service.recoveryTick(); }
    catch {
      logEvent(logger, 'error', 'recovery cycle failed', { reason: 'scheduler-error' });
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

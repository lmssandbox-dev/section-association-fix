'use strict';

const { isAssociation } = require('./rules');
const { logEvent, safeErrorFields } = require('./log');

function createSectionAssociationService({ client, store, reconciler, stabilityMinutes = 10,
  maxReconciliationsPerRun = 50, recoveryIntervalHours = 4, completedReverifyHours = 24,
  now = Date.now, logger = console }) {
  let busy = false;
  const stabilityLogged = new Set();
  const recoveryIntervalMs = recoveryIntervalHours * 60 * 60 * 1000;
  const completedReverifyMs = completedReverifyHours * 60 * 60 * 1000;

  async function discover() {
    const candidates = await client.associationCandidates();
    return candidates.filter(item => isAssociation(item) && /^\d+$/.test(String(item.Identifier ?? item.OrgUnitId ?? '')));
  }

  async function bootstrap(associations) {
    const token = await store.beginBaseline();
    if (!token) return null;
    try {
      const counts = await store.finishBaseline(token, associations.map(item => ({ id: item.Identifier ?? item.OrgUnitId, code: item.Code })));
      const result = { newlyRecorded: counts?.newlyRecorded || 0, alreadyKnown: counts?.alreadyKnown || 0 };
      logEvent(logger, 'info', 'baseline recorded', { candidates: associations.length });
      return result;
    } catch (error) { await store.releaseBaseline(token); throw error; }
  }

  function logDiscovery(stats) {
    logEvent(logger, 'info', 'discovery completed', { candidates: stats.discovered, new: stats.new, alreadyKnown: stats.alreadyKnown });
  }

  function logStabilityWait(id) {
    if (stabilityLogged.has(id)) return;
    stabilityLogged.add(id);
    logEvent(logger, 'info', 'pending', { associationId: id, reason: 'stability-window' });
  }

  function countStatus(stats, result) {
    if (result?.status === 'completed') stats.completed++;
    else if (result?.status === 'blocked') stats.blocked++;
    else stats.pending++;
    stats.associationsChecked++;
    if (Array.isArray(result?.targets) && result.targets.length > 0 &&
        result.targets.every(target => target.status === 'already-inactive')) stats.associationsAlreadyCompliant++;
    if ((result?.writesVerified || 0) > 0) stats.correctionsApplied++;
    if (result?.status === 'blocked' || result?.error) stats.errors++;
    stats.writesAttempted += result?.writesAttempted || 0;
    stats.writesVerified += result?.writesVerified || 0;
    stats.alreadyInactive += result?.alreadyInactive || 0;
  }

  async function prepareDiscovery(stats, setPhase = () => {}) {
    const associations = await discover();
    stats.discovered = associations.length;
    setPhase('database');
    let baseline = await store.baselineStatus();
    if (!baseline || baseline.state !== 'ready') {
      const counts = await bootstrap(associations);
      if (!counts) {
        baseline = await store.baselineStatus();
        if (!baseline || baseline.state !== 'ready') return false;
      } else {
        stats.new += counts.newlyRecorded;
        stats.alreadyKnown += counts.alreadyKnown;
      }
    }
    if (baseline?.state === 'ready') {
      for (const item of associations) {
        const isNew = await store.recordDiscovery(item.Identifier ?? item.OrgUnitId, item.Code);
        if (isNew) stats.new++;
        else stats.alreadyKnown++;
      }
    }
    logDiscovery(stats);
    return true;
  }

  async function processWork(items, stats, execution) {
    for (const item of items) {
      const id = String(item.associationOrgUnitId);
      stabilityLogged.delete(id);
      const result = await reconciler.reconcileAssociation(id, { associationCode: item.associationCode, force: true,
        execution, recordAudit: store.recordAudit });
      stats.processedThisRun++;
      countStatus(stats, result);
    }
  }

  function newStats(discovered = 0) {
    return { candidates: discovered, discovered, new: 0, alreadyKnown: 0, pending: 0, historicalPending: 0,
      blocked: 0, completed: 0, dueForReverification: 0, processedThisRun: 0, remainingHistoricalBacklog: null,
      associationsChecked: 0, associationsAlreadyCompliant: 0, correctionsApplied: 0, errors: 0,
      writesAttempted: 0, writesVerified: 0, alreadyInactive: 0 };
  }

  async function runCycle({ recovery = false, maxReconciliations = maxReconciliationsPerRun, execution } = {}) {
    const startedAt = now();
    const name = recovery ? 'recovery cycle' : 'fast cycle';
    logEvent(logger, 'info', `${name} started`);
    const stats = newStats();
    if (busy) {
      logEvent(logger, 'warn', `${name} skipped`, { reason: 'already-running' });
      logEvent(logger, 'info', `${name} finished`, { status: 'skipped', elapsedMs: Math.max(0, now() - startedAt) });
      return { status: 'skipped', processedThisRun: 0 };
    }
    busy = true;
    let phase = 'discovery';
    let succeeded = false;
    let recoveryComplete = true;
    try {
      if (!await prepareDiscovery(stats, value => { phase = value; })) {
        succeeded = true;
        return { status: 'completed', ...stats, recoveryComplete: false };
      }
      phase = 'database';
      const time = now();
      const stabilityCutoff = new Date(time - stabilityMinutes * 60000);
      stats.historicalPending = await store.countHistoricalBacklog();
      if (recovery) {
        const reverifyBefore = new Date(time - completedReverifyMs);
        stats.dueForReverification = await store.countDueCompleted(reverifyBefore);
        const items = await store.listRecoveryWork({ limit: maxReconciliations,
          stabilityCutoff, blockedBefore: new Date(time - recoveryIntervalMs),
          reverifyBefore });
        await processWork(items, stats, execution);
        recoveryComplete = await store.countRecoveryWork({ stabilityCutoff,
          blockedBefore: new Date(time - recoveryIntervalMs), reverifyBefore }) === 0;
        if (!recoveryComplete) logEvent(logger, 'warn', 'recovery deferred', { reason: 'work-remains' });
      } else {
        for (const item of await store.listWaitingNew({ stabilityCutoff })) {
          stats.pending++;
          logStabilityWait(item.associationOrgUnitId);
        }
        const items = await store.listFastWork({ limit: maxReconciliations, stabilityCutoff });
        await processWork(items, stats, execution);
      }
      stats.remainingHistoricalBacklog = await store.countHistoricalBacklog();
      succeeded = true;
      return { status: 'completed', ...stats, recoveryComplete };
    } catch (error) {
      const errorPhase = error?.phase || phase;
      const endpoint = error?.endpoint || (errorPhase === 'oauth' ? 'oauth-token' : ['discovery', 'oauth/api-read'].includes(errorPhase) ? 'association-candidates' : undefined);
      logEvent(logger, 'error', recovery ? 'recovery cycle failed' : 'fast cycle failed', safeErrorFields(error, {
        phase: errorPhase, endpoint, elapsedMs: Math.max(0, now() - startedAt)
      }));
      stats.errors++;
      return { status: 'failed', phase: errorPhase, code: error?.code, ...stats };
    } finally {
      busy = false;
      if (succeeded) logEvent(logger, 'info', recovery ? 'recovery cycle completed' : 'fast cycle completed', stats);
      logEvent(logger, 'info', `${name} finished`, { status: succeeded ? 'completed' : 'failed', elapsedMs: Math.max(0, now() - startedAt) });
    }
  }

  async function fastTick(options) { return runCycle(options); }
  async function recoveryTick(options) { return runCycle({ ...options, recovery: true }); }

  return { discover, fastTick, recoveryTick };
}

module.exports = { createSectionAssociationService };

'use strict';

const { isAssociation } = require('./rules');
const { logEvent } = require('./log');

function createSectionAssociationService({ client, store, reconciler, stabilityMinutes = 10, now = Date.now, logger = console }) {
  let busy = false;
  const stabilityLogged = new Set();

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
      logEvent(logger, 'info', 'discovery completed', { candidates: associations.length, new: result.newlyRecorded, alreadyKnown: result.alreadyKnown });
      logEvent(logger, 'info', 'baseline recorded', { completed: associations.length });
      return result;
    } catch (error) { await store.releaseBaseline(token); throw error; }
  }

  function logDiscovery(stats) {
    logEvent(logger, 'info', 'discovery completed', { candidates: stats.candidates, new: stats.new, alreadyKnown: stats.alreadyKnown });
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
  }

  async function fastTick() {
    logEvent(logger, 'info', 'fast cycle started');
    const stats = { candidates: 0, new: 0, alreadyKnown: 0, pending: 0, completed: 0, blocked: 0 };
    if (busy) {
      logEvent(logger, 'warn', 'fast cycle skipped', { reason: 'already-running' });
      logEvent(logger, 'info', 'fast cycle completed', { ...stats, skipped: 1 });
      return;
    }
    busy = true;
    try {
      const associations = await discover();
      stats.candidates = associations.length;
      const baseline = await store.baselineStatus();
      if (!baseline || baseline.state !== 'ready') {
        const counts = await bootstrap(associations);
        if (counts) {
          stats.new = counts.newlyRecorded;
          stats.alreadyKnown = counts.alreadyKnown;
          stats.completed = associations.length;
          stabilityLogged.clear();
        }
        return;
      }
      const time = now();
      for (const item of associations) {
        const id = String(item.Identifier ?? item.OrgUnitId);
        const saved = await store.get(id);
        if (saved) stats.alreadyKnown++;
        else stats.new++;
        if (saved?.status === 'completed' || saved?.baseline) {
          await store.record(id, { associationCode: item.Code, status: saved.status, lastCheckedAt: saved.lastCheckedAt, processedAt: saved.processedAt, lastError: saved.lastError, baseline: saved.baseline });
          stats.completed++;
          stabilityLogged.delete(id);
          continue;
        }
        await store.record(id, { associationCode: item.Code, status: saved?.status || 'pending', lastError: saved?.lastError || null });
        const current = await store.get(id);
        if (time - new Date(current.firstSeenAt).getTime() < stabilityMinutes * 60000) {
          stats.pending++;
          logStabilityWait(id);
          continue;
        }
        stabilityLogged.delete(id);
        const result = await reconciler.reconcileAssociation(id, { associationCode: item.Code });
        countStatus(stats, result);
      }
      logDiscovery(stats);
    } catch {
      logEvent(logger, 'error', 'fast cycle failed', { reason: 'cycle-error' });
    } finally {
      busy = false;
      logEvent(logger, 'info', 'fast cycle completed', stats);
    }
  }

  async function recoveryTick() {
    logEvent(logger, 'info', 'recovery cycle started');
    const stats = { candidates: 0, new: 0, alreadyKnown: 0, pending: 0, completed: 0, blocked: 0 };
    if (busy) {
      logEvent(logger, 'warn', 'recovery cycle skipped', { reason: 'already-running' });
      logEvent(logger, 'info', 'recovery cycle completed', { pending: 0, blocked: 0, completed: 0, skipped: 1 });
      return;
    }
    busy = true;
    try {
      const associations = await discover();
      stats.candidates = associations.length;
      const baseline = await store.baselineStatus();
      if (!baseline || baseline.state !== 'ready') {
        const counts = await bootstrap(associations);
        if (counts) {
          stats.new = counts.newlyRecorded;
          stats.alreadyKnown = counts.alreadyKnown;
          stats.completed = associations.length;
          stabilityLogged.clear();
        }
        return;
      }
      for (const item of associations) {
        const id = String(item.Identifier ?? item.OrgUnitId);
        const saved = await store.get(id);
        if (!saved) {
          stats.new++;
          await store.record(id, { associationCode: item.Code, status: 'pending', lastError: null });
        } else {
          stats.alreadyKnown++;
          if (saved.status === 'completed' || saved.baseline) stats.completed++;
          await store.record(id, { associationCode: item.Code, status: saved.status, processedAt: saved.processedAt,
            lastCheckedAt: saved.lastCheckedAt, lastError: saved.lastError, baseline: saved.baseline });
        }
      }
      logDiscovery(stats);
      const items = await store.listUncompleted();
      for (const item of items) {
        const id = item.associationOrgUnitId;
        if (now() - new Date(item.firstSeenAt).getTime() < stabilityMinutes * 60000) {
          stats.pending++;
          logStabilityWait(id);
          continue;
        }
        stabilityLogged.delete(id);
        const result = await reconciler.reconcileAssociation(id, { associationCode: item.associationCode });
        countStatus(stats, result);
      }
    } catch {
      logEvent(logger, 'error', 'recovery cycle failed', { reason: 'cycle-error' });
    } finally {
      busy = false;
      logEvent(logger, 'info', 'recovery cycle completed', { pending: stats.pending, blocked: stats.blocked, completed: stats.completed });
    }
  }

  return { discover, fastTick, recoveryTick };
}

module.exports = { createSectionAssociationService };

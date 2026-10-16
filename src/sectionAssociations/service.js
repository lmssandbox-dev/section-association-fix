'use strict';

const { isAssociation } = require('./rules');

function createSectionAssociationService({ client, store, reconciler, stabilityMinutes = 10, now = Date.now, logger = console }) {
  let fastBusy = false;
  let recoveryBusy = false;

  async function discover() {
    const candidates = await client.associationCandidates();
    return candidates.filter(item => isAssociation(item) && /^\d+$/.test(String(item.Identifier ?? item.OrgUnitId ?? '')));
  }

  async function fastTick() {
    if (fastBusy) return;
    fastBusy = true;
    try {
      const associations = await discover();
      const baseline = await store.baselineStatus();
      if (!baseline || baseline.state !== 'ready') {
        const token = await store.beginBaseline();
        if (!token) return;
        try {
          await store.finishBaseline(token, associations.map(item => ({ id: item.Identifier ?? item.OrgUnitId, code: item.Code })));
          logger.info?.(`Section Association baseline recorded (${associations.length} existing offerings).`);
        } catch (error) { await store.releaseBaseline(token); throw error; }
        return;
      }
      const time = now();
      for (const item of associations) {
        const id = String(item.Identifier ?? item.OrgUnitId);
        const saved = await store.get(id);
        if (saved?.status === 'completed' || saved?.baseline) {
          await store.record(id, { associationCode: item.Code, status: saved.status, lastCheckedAt: saved.lastCheckedAt, processedAt: saved.processedAt, lastError: saved.lastError, baseline: saved.baseline });
          continue;
        }
        await store.record(id, { associationCode: item.Code, status: saved?.status || 'pending', lastError: saved?.lastError || null });
        const current = await store.get(id);
        if (time - new Date(current.firstSeenAt).getTime() < stabilityMinutes * 60000) continue;
        await reconciler.reconcileAssociation(id);
      }
    } catch (error) { logger.error?.(`Section Association fast loop failed: ${safeError(error)}`); }
    finally { fastBusy = false; }
  }

  async function recoveryTick() {
    if (recoveryBusy) return;
    recoveryBusy = true;
    try {
      const associations = await discover();
      const baseline = await store.baselineStatus();
      if (!baseline || baseline.state !== 'ready') { await fastTick(); return; }
      for (const item of associations) {
        const id = String(item.Identifier ?? item.OrgUnitId);
        const saved = await store.get(id);
        if (!saved) await store.record(id, { associationCode: item.Code, status: 'pending', lastError: null });
        else await store.record(id, { associationCode: item.Code, status: saved.status, processedAt: saved.processedAt,
          lastCheckedAt: saved.lastCheckedAt, lastError: saved.lastError, baseline: saved.baseline });
      }
      const items = await store.listUncompleted();
      for (const item of items) {
        if (now() - new Date(item.firstSeenAt).getTime() < stabilityMinutes * 60000) continue;
        await reconciler.reconcileAssociation(item.associationOrgUnitId);
      }
    } catch (error) { logger.error?.(`Section Association recovery loop failed: ${safeError(error)}`); }
    finally { recoveryBusy = false; }
  }
  return { discover, fastTick, recoveryTick };
}

function safeError(error) { return String(error?.message || 'Unknown error').replace(/[\r\n\0-\x1f]/g, ' ').slice(0, 200); }
module.exports = { createSectionAssociationService };

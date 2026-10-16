'use strict';

const { isAssociation } = require('./rules');

function createSectionAssociationService({ client, store, reconciler, stabilityMinutes = 10, now = Date.now, logger = console }) {
  let busy = false;

  async function discover() {
    const candidates = await client.associationCandidates();
    return candidates.filter(item => isAssociation(item) && /^\d+$/.test(String(item.Identifier ?? item.OrgUnitId ?? '')));
  }

  async function bootstrap(associations) {
    const token = await store.beginBaseline();
    if (!token) return;
    try {
      await store.finishBaseline(token, associations.map(item => ({ id: item.Identifier ?? item.OrgUnitId, code: item.Code })));
      logger.info?.(`Section Association baseline recorded (${associations.length} existing offerings).`);
    } catch (error) { await store.releaseBaseline(token); throw error; }
  }

  async function fastTick() {
    if (busy) return;
    busy = true;
    try {
      const associations = await discover();
      const baseline = await store.baselineStatus();
      if (!baseline || baseline.state !== 'ready') {
        await bootstrap(associations);
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
        const result = await reconciler.reconcileAssociation(id);
        reportResult(logger, id, result);
      }
    } catch (error) { logger.error?.(`Section Association fast loop failed: ${safeError(error)}`); }
    finally { busy = false; }
  }

  async function recoveryTick() {
    if (busy) return;
    busy = true;
    try {
      const associations = await discover();
      const baseline = await store.baselineStatus();
      if (!baseline || baseline.state !== 'ready') { await bootstrap(associations); return; }
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
        const result = await reconciler.reconcileAssociation(item.associationOrgUnitId);
        reportResult(logger, item.associationOrgUnitId, result);
      }
    } catch (error) { logger.error?.(`Section Association recovery loop failed: ${safeError(error)}`); }
    finally { busy = false; }
  }
  return { discover, fastTick, recoveryTick };
}

function safeError(error) { return String(typeof error === 'string' ? error : error?.message || 'Unknown error').replace(/[\r\n\0-\x1f]/g, ' ').slice(0, 200); }
function reportResult(logger, associationOrgUnitId, result) {
  if (result?.dryRun) {
    const codes = (result.targets || []).filter(target => target.status === 'would-inactivate').map(target => target.code);
    logger.info?.(`Section Association dry-run ${associationOrgUnitId}: would inactivate ${codes.length} Course Offering(s) [${codes.join(', ')}].`);
  } else if (result?.status === 'completed') {
    logger.info?.(`Section Association ${associationOrgUnitId} reconciliation completed.`);
  } else if (result?.error) {
    logger.warn?.(`Section Association ${associationOrgUnitId} is ${result.status}: ${safeError(result.error)}.`);
  }
}
module.exports = { createSectionAssociationService };

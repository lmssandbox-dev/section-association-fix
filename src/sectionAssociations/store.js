'use strict';

const { MongoClient } = require('mongodb');
const { randomUUID } = require('node:crypto');

const DISCOVERY_BATCH_SIZE = 500;

function createSectionAssociationStore({ uri, namespace, mongoClient, now = Date.now }) {
  const client = mongoClient || new MongoClient(uri, { serverSelectionTimeoutMS: 10000, socketTimeoutMS: 15000 });
  let ready;
  async function collections() {
    ready ||= (async () => {
      if (!mongoClient) await client.connect();
      const db = client.db();
      const associations = db.collection('section_associations');
      await associations.createIndex({ namespace: 1, associationOrgUnitId: 1 }, { unique: true });
      const meta = db.collection('section_association_meta');
      await meta.createIndex({ namespace: 1, history: 1, startedAt: -1, executionId: -1 });
      const audit = db.collection('section_association_audit');
      await audit.createIndex({ namespace: 1, executionId: 1, kind: 1, recordKey: 1 }, { unique: true });
      await audit.createIndex({ namespace: 1, executionId: 1, kind: 1 });
      return { associations, meta, audit };
    })().catch(error => { ready = null; throw error; });
    return ready;
  }
  async function get(id) {
    const { associations } = await collections();
    return associations.findOne({ namespace, associationOrgUnitId: String(id) });
  }
  async function record(id, fields) {
    const { associations } = await collections();
    const time = new Date(now());
    const filter = { namespace, associationOrgUnitId: String(id) };
    const update = { $set: { ...fields, lastSeenAt: time },
      $setOnInsert: { firstSeenAt: time, associationOrgUnitId: String(id), namespace } };
    try { await associations.updateOne(filter, update, { upsert: true }); }
    catch (error) {
      if (error.code !== 11000) throw error;
      await associations.updateOne(filter, { $set: { ...fields, lastSeenAt: time } });
    }
  }
  async function baselineStatus() {
    const { meta } = await collections();
    return meta.findOne({ _id: `baseline:${namespace}` });
  }
  async function beginBaseline() {
    const { meta } = await collections();
    const token = `${process.pid}:${now()}:${Math.random()}`;
    const time = new Date(now());
    let result;
    try {
      result = await meta.findOneAndUpdate({ _id: `baseline:${namespace}`, state: { $ne: 'ready' },
        $or: [{ leaseUntil: { $lte: time } }, { leaseUntil: { $exists: false } }] },
      { $set: { leaseToken: token, leaseUntil: new Date(time.getTime() + 120000) }, $setOnInsert: { state: 'pending', namespace } },
      { upsert: true, returnDocument: 'after' });
    } catch (error) { if (error.code === 11000) return null; throw error; }
    if (!result.value || result.value.leaseToken !== token || result.value.state === 'ready') return null;
    return token;
  }
  async function finishBaseline(token, records) {
    const { associations, meta } = await collections();
    const metaId = `baseline:${namespace}`;
    const baselineAt = new Date(now());
    let newlyRecorded = 0;
    let alreadyKnown = 0;
    for (let offset = 0; offset < records.length; offset += DISCOVERY_BATCH_SIZE) {
      const batch = records.slice(offset, offset + DISCOVERY_BATCH_SIZE);
      const result = await associations.bulkWrite(batch.map(item => ({ updateOne: {
        filter: { namespace, associationOrgUnitId: String(item.id) },
        update: { $set: { associationCode: item.code, lastSeenAt: baselineAt },
          $setOnInsert: { namespace, associationOrgUnitId: String(item.id), firstSeenAt: baselineAt,
            status: 'pending', baseline: true, lastError: null } }, upsert: true
      } })), { ordered: false });
      newlyRecorded += result.upsertedCount || 0;
      alreadyKnown += result.matchedCount || 0;
    }
    const result = await meta.updateOne({ _id: metaId, leaseToken: token, state: { $ne: 'ready' } },
      { $set: { state: 'ready', completedAt: baselineAt }, $unset: { leaseToken: '', leaseUntil: '' } });
    if (!result.matchedCount) throw new Error('Could not finalize Section Association baseline.');
    return { newlyRecorded, alreadyKnown };
  }
  async function releaseBaseline(token) {
    const { meta } = await collections();
    await meta.updateOne({ _id: `baseline:${namespace}`, leaseToken: token }, { $unset: { leaseToken: '', leaseUntil: '' } });
  }
  async function recordDiscovery(id, code) {
    const { associations } = await collections();
    const time = new Date(now());
    const filter = { namespace, associationOrgUnitId: String(id) };
    const update = { $set: { associationCode: code, lastSeenAt: time },
      $setOnInsert: { namespace, associationOrgUnitId: String(id), firstSeenAt: time,
        status: 'pending', baseline: false, lastError: null } };
    try {
      const result = await associations.updateOne(filter, update, { upsert: true });
      return (result.upsertedCount || 0) > 0;
    }
    catch (error) {
      if (error.code !== 11000) throw error;
      await associations.updateOne(filter, { $set: update.$set });
      return false;
    }
  }
  async function recordDiscoveries(records) {
    const { associations } = await collections();
    const unique = [...new Map(records.map(item => [String(item.id), { id: String(item.id), code: item.code }])).values()];
    const time = new Date(now());
    let newlyRecorded = 0;
    let alreadyKnown = 0;
    for (let offset = 0; offset < unique.length; offset += DISCOVERY_BATCH_SIZE) {
      const batch = unique.slice(offset, offset + DISCOVERY_BATCH_SIZE);
      const ids = batch.map(item => item.id);
      const existing = await associations.find({ namespace, associationOrgUnitId: { $in: ids } },
        { projection: { associationOrgUnitId: 1 } }).toArray();
      const knownIds = new Set(existing.map(item => String(item.associationOrgUnitId)));
      const known = batch.filter(item => knownIds.has(item.id));
      const fresh = batch.filter(item => !knownIds.has(item.id));
      alreadyKnown += known.length;

      // Keep lastSeenAt current for operational visibility, but send updates in bounded batches.
      if (known.length) {
        await associations.bulkWrite(known.map(item => ({ updateOne: {
          filter: { namespace, associationOrgUnitId: item.id },
          update: { $set: { associationCode: item.code, lastSeenAt: time } }
        } })), { ordered: false });
      }
      if (!fresh.length) continue;
      const operations = fresh.map(item => ({ updateOne: {
        filter: { namespace, associationOrgUnitId: item.id },
        update: { $setOnInsert: { namespace, associationOrgUnitId: item.id, associationCode: item.code,
          firstSeenAt: time, lastSeenAt: time, status: 'pending', baseline: false, lastError: null } },
        upsert: true
      } }));
      try {
        const result = await associations.bulkWrite(operations, { ordered: false });
        newlyRecorded += result.upsertedCount || 0;
        alreadyKnown += result.matchedCount || 0;
      } catch (error) {
        const writeErrors = error.writeErrors || error.result?.writeErrors || [];
        const onlyDuplicateRaces = writeErrors.length > 0 && writeErrors.every(item => item.code === 11000) &&
          !(error.writeConcernErrors?.length || error.result?.writeConcernErrors?.length);
        if (!onlyDuplicateRaces) throw error;
        const raced = await associations.find({ namespace, associationOrgUnitId: { $in: fresh.map(item => item.id) } },
          { projection: { associationOrgUnitId: 1 } }).toArray();
        const racedIds = new Set(raced.map(item => String(item.associationOrgUnitId)));
        const missing = fresh.filter(item => !racedIds.has(item.id));
        if (missing.length) throw error;
        // BulkWriteError result exposes operations that succeeded before duplicate-key races.
        const partial = error.result?.result || error.result;
        const inserted = partial?.nUpserted ?? partial?.upsertedCount ?? 0;
        newlyRecorded += inserted;
        alreadyKnown += fresh.length - inserted;
      }
    }
    return { newlyRecorded, alreadyKnown };
  }
  const sortOrder = { lastCheckedAt: 1, firstSeenAt: 1, associationOrgUnitId: 1 };
  async function queryBucket(associations, filter, limit, workType) {
    if (limit <= 0) return [];
    const rows = await associations.find(filter).sort(sortOrder).limit(limit).toArray();
    return rows.map(item => ({ ...item, workType }));
  }
  async function listFastWork({ limit, stabilityCutoff, includeCompletedReverification = false, reverifyBefore }) {
    const { associations } = await collections();
    const selected = [];
    const seen = new Set();
    const buckets = [
      ['new', { namespace, baseline: { $ne: true }, status: 'pending', lastCheckedAt: { $exists: false }, firstSeenAt: { $lte: stabilityCutoff } }],
      ['pending', { namespace, baseline: { $ne: true }, status: 'pending', lastCheckedAt: { $exists: true } }],
      ['historical', { namespace, baseline: true, $or: [
        { status: 'pending' },
        { status: 'completed', $or: [{ reconciliationVersion: { $ne: 1 } },
          { lastReconciledAt: { $exists: false } }, { lastVerifiedAt: { $exists: false } }] }
      ] }]
    ];
    if (includeCompletedReverification && reverifyBefore) {
      buckets.push(['reverify', { namespace, status: 'completed', reconciliationVersion: 1,
        lastVerifiedAt: { $lte: reverifyBefore } }]);
    }
    for (const [workType, filter] of buckets) {
      const remaining = limit - selected.length;
      for (const item of await queryBucket(associations, filter, remaining, workType)) {
        const id = String(item.associationOrgUnitId);
        if (!seen.has(id)) { seen.add(id); selected.push(item); }
      }
      if (selected.length >= limit) break;
    }
    return selected;
  }
  async function listWaitingNew({ stabilityCutoff, limit = 1000 }) {
    const { associations } = await collections();
    return associations.find({ namespace, baseline: { $ne: true }, status: 'pending',
      lastCheckedAt: { $exists: false }, firstSeenAt: { $gt: stabilityCutoff } })
      .sort(sortOrder).limit(limit).toArray();
  }
  async function listRecoveryWork({ limit, stabilityCutoff, blockedBefore }) {
    const { associations } = await collections();
    const selected = [];
    const seen = new Set();
    const buckets = [
      ['new', { namespace, baseline: { $ne: true }, status: 'pending', lastCheckedAt: { $exists: false }, firstSeenAt: { $lte: stabilityCutoff } }],
      ['pending', { namespace, baseline: { $ne: true }, status: 'pending', lastCheckedAt: { $exists: true } }],
      ['historical', { namespace, baseline: true, $or: [
        { status: 'pending' },
        { status: 'completed', $or: [{ reconciliationVersion: { $ne: 1 } },
          { lastReconciledAt: { $exists: false } }, { lastVerifiedAt: { $exists: false } }] }
      ] }],
      ['blocked', { namespace, status: 'blocked', $or: [{ lastCheckedAt: { $lte: blockedBefore } }, { lastCheckedAt: { $exists: false } }] }]
    ];
    for (const [workType, filter] of buckets) {
      const remaining = limit - selected.length;
      for (const item of await queryBucket(associations, filter, remaining, workType)) {
        const id = String(item.associationOrgUnitId);
        if (!seen.has(id)) { seen.add(id); selected.push(item); }
      }
      if (selected.length >= limit) break;
    }
    return selected;
  }
  async function countHistoricalBacklog() {
    const { associations } = await collections();
    return associations.countDocuments({ namespace, baseline: true,
      $or: [{ status: 'pending' }, { status: 'blocked' }, { status: 'completed', $or: [
        { reconciliationVersion: { $ne: 1 } }, { lastReconciledAt: { $exists: false } },
        { lastVerifiedAt: { $exists: false } }
      ] }] });
  }
  async function countDueCompleted(reverifyBefore) {
    const { associations } = await collections();
    return associations.countDocuments({ namespace, status: 'completed', reconciliationVersion: 1,
      lastVerifiedAt: { $lte: reverifyBefore } });
  }
  async function countRecoveryWork({ stabilityCutoff, blockedBefore }) {
    const { associations } = await collections();
    const queries = [
      { namespace, baseline: { $ne: true }, status: 'pending', lastCheckedAt: { $exists: false }, firstSeenAt: { $lte: stabilityCutoff } },
      { namespace, baseline: { $ne: true }, status: 'pending', lastCheckedAt: { $exists: true } },
      { namespace, baseline: true, $or: [
        { status: 'pending' },
        { status: 'completed', $or: [{ reconciliationVersion: { $ne: 1 } },
          { lastReconciledAt: { $exists: false } }, { lastVerifiedAt: { $exists: false } }] }
      ] },
      { namespace, status: 'blocked', $or: [{ lastCheckedAt: { $lte: blockedBefore } }, { lastCheckedAt: { $exists: false } }] }
    ];
    const counts = await Promise.all(queries.map(filter => associations.countDocuments(filter)));
    return counts.reduce((sum, count) => sum + count, 0);
  }
  const cronMetaId = `cron:${namespace}`;
  const fullDiscoveryMetaId = `full-discovery:${namespace}`;
  async function lastFullDiscoveryAt() {
    const { meta } = await collections();
    const state = await meta.findOne({ _id: fullDiscoveryMetaId }, { projection: { completedAt: 1 } });
    return state?.completedAt instanceof Date ? state.completedAt : null;
  }
  async function markFullDiscoveryCompleted() {
    const { meta } = await collections();
    const time = new Date(now());
    await meta.updateOne({ _id: fullDiscoveryMetaId }, { $set: { namespace, completedAt: time } }, { upsert: true });
    return time;
  }
  async function acquireCronLease(leaseMs = 120000, owner = 'cron') {
    const { meta } = await collections();
    const time = new Date(now());
    const token = randomUUID();
    try {
      const result = await meta.findOneAndUpdate({ _id: cronMetaId,
        $or: [{ leaseUntil: { $lte: time } }, { leaseUntil: { $exists: false } }] },
      { $set: { leaseToken: token, leaseOwner: owner, leaseAcquiredAt: time,
        leaseUntil: new Date(time.getTime() + leaseMs) },
        $setOnInsert: { namespace } }, { upsert: true, returnDocument: 'after' });
      return result.value?.leaseToken === token ? token : null;
    } catch (error) {
      if (error.code === 11000) return null;
      throw error;
    }
  }
  async function renewCronLease(token, leaseMs = 120000) {
    const { meta } = await collections();
    const time = new Date(now());
    const result = await meta.updateOne({ _id: cronMetaId, leaseToken: token, leaseUntil: { $gt: time } },
      { $set: { leaseUntil: new Date(time.getTime() + leaseMs) } });
    if (result.matchedCount !== 1) throw Object.assign(new Error('Section Association cron lease lost.'), { code: 'CRON_LEASE_LOST' });
  }
  async function releaseCronLease(token) {
    const { meta } = await collections();
    return meta.updateOne({ _id: cronMetaId, leaseToken: token }, { $unset: {
      leaseToken: '', leaseOwner: '', leaseAcquiredAt: '', leaseUntil: ''
    } });
  }
  async function cronLeaseStatus() {
    const { meta } = await collections();
    const state = await meta.findOne({ _id: cronMetaId }, { projection: {
      _id: 1, leaseOwner: 1, leaseAcquiredAt: 1, leaseUntil: 1
    } });
    const expiresAt = state?.leaseUntil instanceof Date ? state.leaseUntil : null;
    return { leaseKey: cronMetaId, owner: state?.leaseOwner || 'unknown',
      acquiredAt: state?.leaseAcquiredAt instanceof Date ? state.leaseAcquiredAt : null,
      expiresAt, expired: !expiresAt || expiresAt.getTime() <= now() };
  }
  async function recoveryDue(intervalMs) {
    const { meta } = await collections();
    const state = await meta.findOne({ _id: cronMetaId }, { projection: { lastRecoveryAt: 1 } });
    return !Number.isFinite(state?.lastRecoveryAt) || now() - state.lastRecoveryAt >= intervalMs;
  }
  async function markRecoveryCompleted(token) {
    const { meta } = await collections();
    const result = await meta.updateOne({ _id: cronMetaId, leaseToken: token, leaseUntil: { $gt: new Date(now()) } },
      { $set: { lastRecoveryAt: now() } });
    if (result.matchedCount !== 1) throw Object.assign(new Error('Section Association cron lease lost.'), { code: 'CRON_LEASE_LOST' });
  }
  const maintenanceExecutionId = `maintenance-execution:${namespace}`;
  async function saveMaintenanceExecution(summary) {
    const { meta } = await collections();
    const fields = ['executionId', 'source', 'startedAt', 'completedAt', 'status', 'associationsChecked',
      'alreadyCompliant', 'correctionsApplied', 'errors', 'coverage', 'detailedAuditAvailable'];
    const unset = Object.fromEntries(fields.filter(field => !Object.hasOwn(summary, field)).map(field => [field, '']));
    await meta.updateOne({ _id: `maintenance-history:${namespace}:${summary.executionId}` },
      { $set: { ...summary, namespace, history: true } }, { upsert: true });
    try {
      const result = await meta.updateOne({ _id: maintenanceExecutionId,
        $or: [{ startedAt: { $lte: summary.startedAt } }, { startedAt: { $exists: false } }] },
      { $set: { ...summary, namespace }, ...(Object.keys(unset).length ? { $unset: unset } : {}) }, { upsert: true });
      return (result.matchedCount || result.upsertedCount || 0) > 0;
    } catch (error) {
      // An upsert can race with a newer summary; its duplicate _id means that newer run won.
      if (error.code === 11000) return false;
      throw error;
    }
  }
  async function recordAudit(record) {
    const { audit } = await collections();
    const filter = { namespace, executionId: record.executionId, kind: record.kind, recordKey: record.recordKey };
    await audit.updateOne(filter, { $setOnInsert: { ...record, namespace } }, { upsert: true });
  }
  async function *executionAudit(executionId, kind) {
    const { audit } = await collections();
    const cursor = audit.find({ namespace, executionId: String(executionId), kind }).sort({ timestamp: 1, recordKey: 1 }).batchSize(500);
    for await (const { _id, namespace: _namespace, recordKey: _recordKey, ...record } of cursor) yield record;
  }
  async function auditAvailability(executionId) {
    const { meta } = await collections();
    const summary = await meta.findOne({ _id: `maintenance-history:${namespace}:${String(executionId)}` }, { projection: { detailedAuditAvailable: 1 } });
    return summary?.detailedAuditAvailable === true;
  }
  async function recentMaintenanceExecutions(limit = 50) {
    const { meta } = await collections();
    const rows = await meta.find({ namespace, history: true }).sort({ startedAt: -1, executionId: -1 })
      .limit(Math.min(50, Math.max(0, limit))).toArray();
    return rows.map(({ _id, namespace: _namespace, history: _history, ...summary }) => summary);
  }
  async function *allMaintenanceExecutions() {
    const { meta } = await collections();
    const cursor = meta.find({ namespace, history: true }).sort({ startedAt: -1, executionId: -1 }).batchSize(500);
    for await (const { _id, namespace: _namespace, history: _history, ...summary } of cursor) yield summary;
  }
  async function latestMaintenanceExecution() {
    const { meta } = await collections();
    const result = await meta.findOne({ _id: maintenanceExecutionId });
    if (!result) return null;
    const { _id, namespace: _namespace, ...summary } = result;
    return summary;
  }
  async function close() { if (!mongoClient) await client.close(); }
  return { get, record, baselineStatus, beginBaseline, finishBaseline, releaseBaseline, recordDiscovery, recordDiscoveries,
    listFastWork, listWaitingNew, listRecoveryWork, countHistoricalBacklog, countDueCompleted, countRecoveryWork,
    lastFullDiscoveryAt, markFullDiscoveryCompleted,
    acquireCronLease, renewCronLease, releaseCronLease, cronLeaseStatus, recoveryDue, markRecoveryCompleted,
    saveMaintenanceExecution, latestMaintenanceExecution, recentMaintenanceExecutions, allMaintenanceExecutions,
    recordAudit, executionAudit, auditAvailability, close };
}

module.exports = { createSectionAssociationStore };

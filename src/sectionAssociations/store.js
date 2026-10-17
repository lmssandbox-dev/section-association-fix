'use strict';

const { MongoClient } = require('mongodb');
const { randomUUID } = require('node:crypto');

function createSectionAssociationStore({ uri, namespace, mongoClient, now = Date.now }) {
  const client = mongoClient || new MongoClient(uri, { serverSelectionTimeoutMS: 10000, socketTimeoutMS: 15000 });
  let ready;
  async function collections() {
    ready ||= (async () => {
      if (!mongoClient) await client.connect();
      const db = client.db();
      const associations = db.collection('section_associations');
      await associations.createIndex({ namespace: 1, associationOrgUnitId: 1 }, { unique: true });
      return { associations, meta: db.collection('section_association_meta') };
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
    const baselineResult = records.length ? await associations.bulkWrite(records.map(item => ({ updateOne: {
      filter: { namespace, associationOrgUnitId: String(item.id) },
      update: { $setOnInsert: { namespace, associationOrgUnitId: String(item.id), associationCode: item.code,
        firstSeenAt: baselineAt, lastSeenAt: baselineAt, lastCheckedAt: baselineAt, processedAt: baselineAt,
        status: 'completed', baseline: true, lastError: null } }, upsert: true
    } })), { ordered: false }) : { upsertedCount: 0, matchedCount: 0 };
    const result = await meta.updateOne({ _id: metaId, leaseToken: token, state: { $ne: 'ready' } },
      { $set: { state: 'ready', completedAt: baselineAt }, $unset: { leaseToken: '', leaseUntil: '' } });
    if (!result.matchedCount) throw new Error('Could not finalize Section Association baseline.');
    return { newlyRecorded: baselineResult.upsertedCount || 0, alreadyKnown: baselineResult.matchedCount || 0 };
  }
  async function releaseBaseline(token) {
    const { meta } = await collections();
    await meta.updateOne({ _id: `baseline:${namespace}`, leaseToken: token }, { $unset: { leaseToken: '', leaseUntil: '' } });
  }
  async function listUncompleted() {
    const { associations } = await collections();
    return associations.find({ namespace, status: { $ne: 'completed' }, baseline: { $ne: true } }).toArray();
  }
  async function listBaselineAssociations(limit, associationId) {
    const { associations } = await collections();
    const filter = { namespace, baseline: true };
    if (associationId !== undefined) filter.associationOrgUnitId = String(associationId);
    let cursor = associations.find(filter).sort({ firstSeenAt: 1, associationOrgUnitId: 1 });
    if (Number.isSafeInteger(limit) && limit > 0) cursor = cursor.limit(limit);
    return cursor.toArray();
  }
  async function recordBackfill(id, fields) {
    const { associations } = await collections();
    const allowed = ['backfillLastCheckedAt', 'backfillProcessedAt', 'backfillStatus', 'backfillLastError', 'backfillTargets'];
    const safe = Object.fromEntries(Object.entries(fields).filter(([key]) => allowed.includes(key)));
    const result = await associations.updateOne({ namespace, associationOrgUnitId: String(id), baseline: true }, { $set: safe });
    return result.matchedCount === 1;
  }
  const cronMetaId = `cron:${namespace}`;
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
  async function close() { if (!mongoClient) await client.close(); }
  return { get, record, baselineStatus, beginBaseline, finishBaseline, releaseBaseline, listUncompleted,
    listBaselineAssociations, recordBackfill,
    acquireCronLease, renewCronLease, releaseCronLease, cronLeaseStatus, recoveryDue, markRecoveryCompleted, close };
}

module.exports = { createSectionAssociationStore };

'use strict';

const { MongoClient } = require('mongodb');

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
    if (records.length) await associations.bulkWrite(records.map(item => ({ updateOne: {
      filter: { namespace, associationOrgUnitId: String(item.id) },
      update: { $setOnInsert: { namespace, associationOrgUnitId: String(item.id), associationCode: item.code,
        firstSeenAt: baselineAt, lastSeenAt: baselineAt, lastCheckedAt: baselineAt, processedAt: baselineAt,
        status: 'completed', baseline: true, lastError: null } }, upsert: true
    } })), { ordered: false });
    const result = await meta.updateOne({ _id: metaId, leaseToken: token, state: { $ne: 'ready' } },
      { $set: { state: 'ready', completedAt: baselineAt }, $unset: { leaseToken: '', leaseUntil: '' } });
    if (!result.matchedCount) throw new Error('Could not finalize Section Association baseline.');
  }
  async function releaseBaseline(token) {
    const { meta } = await collections();
    await meta.updateOne({ _id: `baseline:${namespace}`, leaseToken: token }, { $unset: { leaseToken: '', leaseUntil: '' } });
  }
  async function listUncompleted() {
    const { associations } = await collections();
    return associations.find({ namespace, status: { $ne: 'completed' }, baseline: { $ne: true } }).toArray();
  }
  async function close() { if (!mongoClient) await client.close(); }
  return { get, record, baselineStatus, beginBaseline, finishBaseline, releaseBaseline, listUncompleted, close };
}

module.exports = { createSectionAssociationStore };

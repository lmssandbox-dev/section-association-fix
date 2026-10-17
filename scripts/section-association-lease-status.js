'use strict';

require('dotenv').config();

const { createHash } = require('node:crypto');
const { MongoClient } = require('mongodb');
const { databaseConfig } = require('../src/shared/database');

async function main(env = process.env) {
  let client;
  try {
    if (!env.BS_URL || !env.BS_OAUTH2_CLIENT_ID) throw new Error('Missing namespace configuration.');
    const brightspace = new URL(env.BS_URL);
    if (brightspace.protocol !== 'https:' || brightspace.username || brightspace.password || brightspace.search || brightspace.hash) {
      throw new Error('Invalid tenant configuration.');
    }
    const namespace = createHash('sha256').update(`${brightspace.origin}|${env.BS_OAUTH2_CLIENT_ID}`).digest('hex');
    const leaseKey = `cron:${namespace}`;
    const config = databaseConfig(env.DB_MONGODB_URL);
    client = new MongoClient(config.url, { serverSelectionTimeoutMS: 10000, socketTimeoutMS: 15000 });
    await client.connect();
    const state = await client.db().collection('section_association_meta').findOne({ _id: leaseKey }, {
      projection: { _id: 1, leaseOwner: 1, leaseAcquiredAt: 1, leaseUntil: 1 }
    });
    const expiresAt = state?.leaseUntil instanceof Date ? state.leaseUntil : null;
    console.log(`leaseKey=${leaseKey}`);
    console.log(`owner=${safeOwner(state?.leaseOwner)}`);
    console.log(`acquiredAt=${formatDate(state?.leaseAcquiredAt)}`);
    console.log(`expiresAt=${formatDate(expiresAt)}`);
    console.log(`expired=${!expiresAt || expiresAt.getTime() <= Date.now()}`);
    return 0;
  } catch (error) {
    const code = /^[A-Z][A-Z0-9_]{0,63}$/.test(String(error?.code || '')) ? error.code : 'LEASE_STATUS_FAILED';
    console.error(`[section-association] lease status failed code=${code}`);
    return 1;
  } finally {
    if (client) await client.close().catch(() => {});
  }
}

function safeOwner(value) { return value === 'cron' ? value : 'unknown'; }
function formatDate(value) { return value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : 'unknown'; }

if (require.main === module) void main().then(code => { process.exitCode = code; });
module.exports = { main };

'use strict';

require('dotenv').config();

const axios = require('axios');
const { validateWorkerEnvironment } = require('../src/sectionAssociations/config');
const { createSectionAssociationRuntime } = require('../src/sectionAssociations/runtime');
const { createHistoricalBackfill, parseBackfillArgs, writeCsvReport } = require('../src/sectionAssociations/backfill');

async function main(args = process.argv.slice(2), env = process.env) {
  let runtime;
  let lease;
  let heartbeat;
  let heartbeatFailure = false;
  let heartbeatRunning = false;
  try {
    const options = parseBackfillArgs(args);
    validateWorkerEnvironment(env, { requireDryRun: false });
    runtime = createSectionAssociationRuntime({ env, http: axios });
    lease = await runtime.store.acquireCronLease(10 * 60 * 1000, 'backfill');
    if (!lease) {
      try {
        const state = await runtime.store.cronLeaseStatus();
        console.warn(`[section-association-backfill] lease unavailable expiresAt=${state.expiresAt instanceof Date ? state.expiresAt.toISOString() : 'unknown'} owner=${safeOwner(state.owner)}`);
      } catch { console.warn('[section-association-backfill] lease unavailable expiresAt=unknown owner=unknown'); }
      console.warn('[section-association-backfill] run skipped reason=worker-already-running');
      const reportPath = await writeCsvReport({ rows: [] });
      console.log(`[section-association-backfill] report path=${reportPath}`);
      return 1;
    }
    try {
      const state = await runtime.store.cronLeaseStatus();
      console.log(`[section-association-backfill] lease acquired owner=backfill expiresAt=${state.expiresAt instanceof Date ? state.expiresAt.toISOString() : 'unknown'}`);
    } catch { console.log('[section-association-backfill] lease acquired owner=backfill expiresAt=unknown'); }
    heartbeat = setInterval(() => {
      if (heartbeatRunning) return;
      heartbeatRunning = true;
      void runtime.store.renewCronLease(lease, 10 * 60 * 1000)
        .catch(() => { heartbeatFailure = true; })
        .finally(() => { heartbeatRunning = false; });
    }, 60 * 1000);

    const backfill = createHistoricalBackfill({ client: runtime.client, store: runtime.store });
    const result = await backfill.run(options);
    const reportPath = await writeCsvReport({ rows: result.rows });
    console.log(`[section-association-backfill] report path=${reportPath}`);
    return heartbeatFailure || result.summary.errors > 0 ? 1 : 0;
  } catch (error) {
    console.error(`[section-association-backfill] run failed reason=${safeFailure(error)}`);
    try {
      const reportPath = await writeCsvReport({ rows: [] });
      console.log(`[section-association-backfill] report path=${reportPath}`);
    } catch { /* Report creation can fail if the execution filesystem is unavailable. */ }
    return 1;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (lease && runtime) {
      try {
        const released = await runtime.store.releaseCronLease(lease);
        if ((released?.matchedCount ?? released?.modifiedCount ?? 1) > 0) console.log('[section-association-backfill] lease released owner=backfill');
        else console.warn('[section-association-backfill] lease release failed owner=backfill reason=lease-token-not-current');
      } catch (error) {
        console.error(`[section-association-backfill] lease release failed owner=backfill code=${safeFailure(error)}`);
      }
    }
    if (runtime) await runtime.close();
  }
}

function safeFailure(error) {
  const code = String(error?.code || 'BACKFILL_FAILED');
  return /^[A-Z][A-Z0-9_-]{0,63}$/.test(code) ? code.toLowerCase().replace(/_/g, '-') : 'backfill-failed';
}
function safeOwner(value) { return value === 'cron' || value === 'backfill' ? value : 'unknown'; }

if (require.main === module) void main().then(code => { process.exitCode = code; });
module.exports = { main };

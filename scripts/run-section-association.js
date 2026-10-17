'use strict';

require('dotenv').config();

const axios = require('axios');
const { databaseConfig } = require('../src/shared/database');
const { hasScope } = require('../src/shared/client');
const { createSectionAssociationRuntime } = require('../src/sectionAssociations/runtime');
const { runSectionAssociationCron } = require('../src/sectionAssociations/cron');
const { validateWorkerEnvironment } = require('../src/sectionAssociations/config');

async function main(env = process.env, dependencies = {}) {
  let runtime;
  try {
    validateWorkerEnvironment(env);
    databaseConfig(env.DB_MONGODB_URL);
    const tenant = new URL(env.BS_URL);
    if (tenant.protocol !== 'https:' || tenant.username || tenant.password || tenant.search || tenant.hash) {
      throw new Error('BS_URL must be the Brightspace HTTPS origin without credentials, query, or fragment.');
    }
    const missingScopes = ['organizations:organization:read', 'orgunits:course:update'].filter(scope => !hasScope(env.BS_OAUTH2_SCOPES, scope));
    if (missingScopes.length) throw new Error(`BS_OAUTH2_SCOPES must include: ${missingScopes.join(', ')}`);
    runtime = (dependencies.createRuntime || createSectionAssociationRuntime)({ env, http: axios });
    const result = await (dependencies.runCron || runSectionAssociationCron)({ service: runtime.service, store: runtime.store,
      recoveryIntervalHours: runtime.recoveryIntervalHours, maxReconciliationsPerRun: runtime.maxReconciliationsPerRun,
      source: maintenanceSource(dependencies.argv || process.argv) });
    return result.exitCode;
  } catch (error) {
    console.error(`[section-association] cron failed phase=scheduler code=INVALID_CONFIGURATION elapsedMs=0`);
    return 1;
  } finally {
    if (runtime) await runtime.close();
  }
}

function maintenanceSource(argv = process.argv) { return argv.includes('--manual') ? 'manual' : 'automatic'; }

if (require.main === module) void main().then(code => { process.exitCode = code; });
module.exports = { main, maintenanceSource };

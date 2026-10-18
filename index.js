'use strict';

require('dotenv').config();

const axios = require('axios');
const lti = require('ltijs').Provider;
const { databaseConfig } = require('./src/shared/database');
const { hasScope } = require('./src/shared/client');
const { startSectionAssociationTrigger } = require('./src/sectionAssociations/trigger');
const { createSectionAssociationRuntime, positiveInteger } = require('./src/sectionAssociations/runtime');
const { validateRequiredEnvironment, ltiConfiguration, registerBrightspacePlatform,
  installPublicBootstrapEndpoints, sectionAssociationTriggerMode } = require('./src/sectionAssociations/config');
const { registerSectionAssociationLtiInterface } = require('./src/sectionAssociations/ltiInterface');

const env = process.env;
const port = Number(env.PORT || 3000);
const {
  DB_MONGODB_URL, APP_LTI_SECRET, BS_URL,
  BS_OAUTH2_SCOPES
} = env;
validateRequiredEnvironment(env);
const triggerMode = sectionAssociationTriggerMode(env);
const D2L_API_LP_VERSION = process.env.D2L_API_LP_VERSION;
const ltiConfig = ltiConfiguration(env);
databaseConfig(DB_MONGODB_URL);
const brightspace = new URL(BS_URL);
if (brightspace.protocol !== 'https:' || brightspace.username || brightspace.password || brightspace.search || brightspace.hash) {
  throw new Error('BS_URL must be the Brightspace HTTPS origin without credentials, query, or fragment.');
}
const missingScopes = ['organizations:organization:read', 'orgunits:course:update'].filter(scope => !hasScope(BS_OAUTH2_SCOPES, scope));
if (missingScopes.length) throw new Error(`BS_OAUTH2_SCOPES must include: ${missingScopes.join(', ')}`);
if (!/^\d+$/.test(String(port)) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port.');

const runtime = createSectionAssociationRuntime({ env, http: axios });
const { oauth, service, fastIntervalMinutes: fastMinutes, recoveryIntervalHours: recoveryHours, dryRun } = runtime;
let sectionAssociationScheduler;

lti.setup(APP_LTI_SECRET, databaseConfig(DB_MONGODB_URL), {
  appRoute: '/', loginRoute: '/login', cookies: { secure: true, sameSite: 'None' }, devMode: false
});
installPublicBootstrapEndpoints(lti, oauth.jwks);
registerSectionAssociationLtiInterface(lti, { deploymentId: env.BS_LTI_DEPLOYMENT_ID,
  getExecutionHistory: () => runtime.store.allMaintenanceExecutions(),
  async getStatus() {
    let worker = 'unknown';
    if (sectionAssociationScheduler) {
      worker = sectionAssociationScheduler.status().state;
    } else {
      try {
        const lease = await runtime.store.cronLeaseStatus();
        worker = lease.expired ? 'idle' : 'running';
      } catch { /* Keep worker state unknown if lease storage is temporarily unavailable. */ }
    }
    const executions = await runtime.store.recentMaintenanceExecutions(50);
    return { availability: 'Available', worker, latestExecution: await runtime.store.latestMaintenanceExecution(), executions,
      nextScheduledExecution: null };
  } });

async function start() {
  try {
    await lti.deploy({ port });
    if (ltiConfig.complete) console.log('LTI configured: Brightspace platform registration enabled.');
    else console.log('LTI setup mode: Brightspace LTI registration is not fully configured.');
    console.log(`Section Association Fix service listening on ${port}; dry-run=${dryRun}.`);
    sectionAssociationScheduler = startSectionAssociationTrigger({ mode: triggerMode, service, store: runtime.store,
      fastIntervalMinutes: fastMinutes, recoveryIntervalHours: recoveryHours });
    if (ltiConfig.complete) {
      try { await registerBrightspacePlatform(lti, ltiConfig); }
      catch { console.error('Brightspace LTI platform registration failed; Section Association processing remains active.'); }
    }
  } catch (error) {
    console.error(`Section Association service startup failed: ${String(error?.message || 'unknown error').replace(/[\r\n]/g, ' ')}`);
    process.exit(1);
  }
}

if (require.main === module) void start();
module.exports = { start, positiveInteger, triggerMode };

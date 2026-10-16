'use strict';

require('dotenv').config();

const axios = require('axios');
const { createHash } = require('node:crypto');
const lti = require('ltijs').Provider;
const { createBrightspaceAuth, logOAuthConfiguration } = require('./src/shared/auth');
const { databaseConfig } = require('./src/shared/database');
const { createBrightspaceGet, hasScope } = require('./src/shared/client');
const { createRateLimitedHttp, createMongoGate, rateLimitKey } = require('./src/shared/rateLimit');
const { createSectionAssociationClient } = require('./src/sectionAssociations/client');
const { createSectionAssociationStore } = require('./src/sectionAssociations/store');
const { createReconciler } = require('./src/sectionAssociations/reconciler');
const { createSectionAssociationService } = require('./src/sectionAssociations/service');
const { startSectionAssociationScheduler } = require('./src/sectionAssociations/scheduler');
const { validateRequiredEnvironment, ltiConfiguration, registerBrightspacePlatform,
  installPublicBootstrapEndpoints } = require('./src/sectionAssociations/config');

const env = process.env;
const port = Number(env.PORT || 3000);
const {
  DB_MONGODB_URL, APP_LTI_SECRET, BS_URL,
  BS_OAUTH2_CLIENT_ID, BS_OAUTH2_PRIVATE_KEY, BS_OAUTH2_KEY_ID, BS_OAUTH2_TOKEN_ENDPOINT,
  BS_OAUTH2_SCOPES
} = env;
validateRequiredEnvironment(env);
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

const namespace = createHash('sha256').update(`${brightspace.origin}|${BS_OAUTH2_CLIENT_ID}`).digest('hex');
const oauthTokenEndpoint = BS_OAUTH2_TOKEN_ENDPOINT || 'https://auth.brightspace.com/core/connect/token';
const oauth = createBrightspaceAuth({ clientId: BS_OAUTH2_CLIENT_ID, scope: BS_OAUTH2_SCOPES,
  kid: BS_OAUTH2_KEY_ID, privateKeyPem: BS_OAUTH2_PRIVATE_KEY,
  tokenEndpoint: oauthTokenEndpoint, http: axios,
  onDiagnostic: diagnostic => console.warn(`[oauth] token exchange rejected protocolCode=${diagnostic.protocolCode} cause=${diagnostic.cause}`) });
logOAuthConfiguration({ clientId: BS_OAUTH2_CLIENT_ID, kid: BS_OAUTH2_KEY_ID,
  tokenEndpoint: oauthTokenEndpoint, scope: BS_OAUTH2_SCOPES, jwks: oauth.jwks });
const apiGate = createMongoGate({ uri: DB_MONGODB_URL, key: rateLimitKey(BS_URL, BS_OAUTH2_CLIENT_ID) });
const apiHttp = createRateLimitedHttp({ http: axios, gate: apiGate, baseUrl: BS_URL });
const get = createBrightspaceGet({ http: apiHttp, oauth, baseUrl: BS_URL, retries: 2 });
const client = createSectionAssociationClient({ get, http: apiHttp, oauth, baseUrl: BS_URL, lpVersion: D2L_API_LP_VERSION });
const store = createSectionAssociationStore({ uri: DB_MONGODB_URL, namespace });
const dryRun = !/^(false|0|no)$/i.test(env.SECTION_ASSOCIATION_FIX_DRY_RUN || 'true');
const stabilityMinutes = positiveInteger(env.SECTION_ASSOCIATION_FIX_STABILITY_MINUTES, 10);
const fastMinutes = positiveInteger(env.SECTION_ASSOCIATION_FIX_FAST_INTERVAL_MINUTES, 15);
const recoveryHours = positiveInteger(env.SECTION_ASSOCIATION_FIX_RECOVERY_INTERVAL_HOURS, 4);
const reconciler = createReconciler({ client, store, dryRun });
const service = createSectionAssociationService({ client, store, reconciler, stabilityMinutes });
let sectionAssociationScheduler;

// LTI remains available as the future protected admin layer. The worker never uses an LTI token.
lti.setup(APP_LTI_SECRET, databaseConfig(DB_MONGODB_URL), {
  appRoute: '/', loginRoute: '/login', cookies: { secure: true, sameSite: 'None' }, devMode: false
});
installPublicBootstrapEndpoints(lti, oauth.jwks);
lti.onConnect((_token, _req, res) => res.type('html').send('<main><h1>Section Association cleanup</h1><p>Administrative tools are not enabled yet.</p></main>'));

async function start() {
  try {
    await lti.deploy({ port });
    if (ltiConfig.complete) console.log('LTI configured: Brightspace platform registration enabled.');
    else console.log('LTI setup mode: Brightspace LTI registration is not fully configured.');
    console.log(`Section Association cleanup service listening on ${port}; dry-run=${dryRun}.`);
    sectionAssociationScheduler = startSectionAssociationScheduler({ service,
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

function positiveInteger(value, fallback) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 10080) throw new Error('Section Association schedule settings must be positive whole numbers.');
  return parsed;
}

if (require.main === module) void start();
module.exports = { start, positiveInteger };

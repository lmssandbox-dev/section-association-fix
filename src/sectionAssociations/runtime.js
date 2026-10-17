'use strict';

const { createHash } = require('node:crypto');
const { createBrightspaceAuth, logOAuthConfiguration } = require('../shared/auth');
const { createBrightspaceGet } = require('../shared/client');
const { createRateLimitedHttp, createMongoGate, rateLimitKey } = require('../shared/rateLimit');
const { createSectionAssociationClient } = require('./client');
const { createSectionAssociationStore } = require('./store');
const { createReconciler } = require('./reconciler');
const { createSectionAssociationService } = require('./service');

function createSectionAssociationRuntime({ env = process.env, http, logger = console }) {
  const brightspace = new URL(env.BS_URL);
  const namespace = createHash('sha256').update(`${brightspace.origin}|${env.BS_OAUTH2_CLIENT_ID}`).digest('hex');
  const oauthTokenEndpoint = env.BS_OAUTH2_TOKEN_ENDPOINT || 'https://auth.brightspace.com/core/connect/token';
  const oauth = createBrightspaceAuth({ clientId: env.BS_OAUTH2_CLIENT_ID, scope: env.BS_OAUTH2_SCOPES,
    kid: env.BS_OAUTH2_KEY_ID, privateKeyPem: env.BS_OAUTH2_PRIVATE_KEY,
    tokenEndpoint: oauthTokenEndpoint, http,
    onDiagnostic: diagnostic => logger.warn?.(`[oauth] token exchange rejected protocolCode=${diagnostic.protocolCode} cause=${diagnostic.cause}`) });
  logOAuthConfiguration({ clientId: env.BS_OAUTH2_CLIENT_ID, kid: env.BS_OAUTH2_KEY_ID,
    tokenEndpoint: oauthTokenEndpoint, scope: env.BS_OAUTH2_SCOPES, jwks: oauth.jwks, logger });
  const apiGate = createMongoGate({ uri: env.DB_MONGODB_URL, key: rateLimitKey(env.BS_URL, env.BS_OAUTH2_CLIENT_ID) });
  const apiHttp = createRateLimitedHttp({ http, gate: apiGate, baseUrl: env.BS_URL });
  const get = createBrightspaceGet({ http: apiHttp, oauth, baseUrl: env.BS_URL, retries: 2 });
  const client = createSectionAssociationClient({ get, http: apiHttp, oauth, baseUrl: env.BS_URL,
    lpVersion: env.D2L_API_LP_VERSION });
  const store = createSectionAssociationStore({ uri: env.DB_MONGODB_URL, namespace });
  const dryRun = !/^(false|0|no)$/i.test(env.SECTION_ASSOCIATION_FIX_DRY_RUN || 'true');
  const stabilityMinutes = positiveInteger(env.SECTION_ASSOCIATION_FIX_STABILITY_MINUTES, 10);
  const fastIntervalMinutes = positiveInteger(env.SECTION_ASSOCIATION_FIX_FAST_INTERVAL_MINUTES, 15);
  const recoveryIntervalHours = positiveInteger(env.SECTION_ASSOCIATION_FIX_RECOVERY_INTERVAL_HOURS, 4);
  const maxReconciliationsPerRun = positiveInteger(env.SECTION_ASSOCIATION_FIX_MAX_RECONCILIATIONS_PER_RUN, 50);
  const completedReverifyHours = positiveInteger(env.SECTION_ASSOCIATION_FIX_COMPLETED_REVERIFY_HOURS, 24);
  const reconciler = createReconciler({ client, store, dryRun, logger });
  const service = createSectionAssociationService({ client, store, reconciler, stabilityMinutes,
    recoveryIntervalHours, maxReconciliationsPerRun, completedReverifyHours, logger });
  return { oauth, apiGate, client, store, reconciler, service, namespace, dryRun,
    fastIntervalMinutes, recoveryIntervalHours, maxReconciliationsPerRun, completedReverifyHours,
    async close() { await Promise.allSettled([store.close(), apiGate.close()]); } };
}

function positiveInteger(value, fallback) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 10080) throw new Error('Section Association schedule settings must be positive whole numbers.');
  return parsed;
}

module.exports = { createSectionAssociationRuntime, positiveInteger };

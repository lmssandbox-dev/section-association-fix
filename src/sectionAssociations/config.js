'use strict';

const REQUIRED_ENVIRONMENT = [
  'DB_MONGODB_URL', 'APP_LTI_SECRET', 'BS_URL',
  'BS_OAUTH2_CLIENT_ID', 'BS_OAUTH2_PRIVATE_KEY', 'BS_OAUTH2_KEY_ID',
  'BS_OAUTH2_TOKEN_ENDPOINT', 'BS_OAUTH2_SCOPES', 'D2L_API_LP_VERSION'
];
const LTI_ENVIRONMENT = [
  'BS_LTI_CLIENT_ID', 'BS_LTI_DEPLOYMENT_ID', 'BS_LTI_AUTH_ENDPOINT',
  'BS_LTI_TOKEN_ENDPOINT', 'BS_LTI_KEYSET_URL'
];
const WORKER_ENVIRONMENT = [
  'DB_MONGODB_URL', 'BS_URL', 'BS_OAUTH2_CLIENT_ID', 'BS_OAUTH2_PRIVATE_KEY', 'BS_OAUTH2_KEY_ID',
  'BS_OAUTH2_TOKEN_ENDPOINT', 'BS_OAUTH2_SCOPES', 'D2L_API_LP_VERSION', 'SECTION_ASSOCIATION_FIX_DRY_RUN'
];
const TRIGGER_MODES = new Set(['cron', 'internal']);

function sectionAssociationTriggerMode(env = process.env) {
  const value = String(env.SECTION_ASSOCIATION_FIX_TRIGGER_MODE || 'cron').trim();
  if (!TRIGGER_MODES.has(value)) throw new Error('SECTION_ASSOCIATION_FIX_TRIGGER_MODE must be either cron or internal.');
  return value;
}

function validateRequiredEnvironment(env = process.env) {
  const missing = REQUIRED_ENVIRONMENT.filter(name => !String(env[name] || '').trim());
  if (missing.length) throw new Error(`Missing required environment settings: ${missing.join(', ')}`);
  if (!/^\d+\.\d+$/.test(env.D2L_API_LP_VERSION)) throw new Error('D2L_API_LP_VERSION must use the form major.minor.');
  return true;
}

function validateWorkerEnvironment(env = process.env) {
  const missing = WORKER_ENVIRONMENT.filter(name => !String(env[name] || '').trim());
  if (missing.length) throw new Error(`Missing required worker environment settings: ${missing.join(', ')}`);
  if (!/^\d+\.\d+$/.test(env.D2L_API_LP_VERSION)) throw new Error('D2L_API_LP_VERSION must use the form major.minor.');
  return true;
}

function ltiConfiguration(env = process.env) {
  const values = Object.fromEntries(LTI_ENVIRONMENT.map(name => [name, String(env[name] || '').trim()]));
  return { ...values, BS_URL: env.BS_URL, BS_NAME: env.BS_NAME,
    complete: LTI_ENVIRONMENT.every(name => Boolean(values[name])) };
}

async function registerBrightspacePlatform(provider, config) {
  if (!config?.complete) return false;
  await provider.registerPlatform({
    url: config.BS_URL,
    name: config.BS_NAME || 'Brightspace',
    clientId: config.BS_LTI_CLIENT_ID,
    authenticationEndpoint: config.BS_LTI_AUTH_ENDPOINT,
    accesstokenEndpoint: config.BS_LTI_TOKEN_ENDPOINT,
    authConfig: { method: 'JWK_SET', key: config.BS_LTI_KEYSET_URL }
  });
  return true;
}

function installPublicBootstrapEndpoints(provider, jwks) {
  provider.whitelist({ route: '/.well-known/brightspace-jwks.json', method: 'get' }, { route: '/ping', method: 'get' });
  provider.app.get('/.well-known/brightspace-jwks.json', (_req, res) => res.json(jwks));
  provider.app.get('/ping', (_req, res) => res.type('text/plain').send('Section Association service is running.'));
}

module.exports = { REQUIRED_ENVIRONMENT, LTI_ENVIRONMENT, WORKER_ENVIRONMENT, TRIGGER_MODES,
  sectionAssociationTriggerMode, validateRequiredEnvironment, validateWorkerEnvironment,
  ltiConfiguration, registerBrightspacePlatform, installPublicBootstrapEndpoints };

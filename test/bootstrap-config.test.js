'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  REQUIRED_ENVIRONMENT, LTI_ENVIRONMENT, validateRequiredEnvironment,
  ltiConfiguration, registerBrightspacePlatform, installPublicBootstrapEndpoints,
  sectionAssociationTriggerMode, validateWorkerEnvironment
} = require('../src/sectionAssociations/config');
const { startSectionAssociationTrigger } = require('../src/sectionAssociations/trigger');

function validEnvironment(overrides = {}) {
  return {
    DB_MONGODB_URL: 'mongodb://localhost:27017/section_association',
    APP_LTI_SECRET: 'application-secret',
    BS_URL: 'https://tenant.brightspace.com',
    BS_OAUTH2_CLIENT_ID: 'oauth-client',
    BS_OAUTH2_PRIVATE_KEY: 'private-key-placeholder',
    BS_OAUTH2_KEY_ID: 'oauth-key-id',
    BS_OAUTH2_TOKEN_ENDPOINT: 'https://auth.brightspace.com/core/connect/token',
    BS_OAUTH2_SCOPES: 'organizations:organization:read orgunits:course:update',
    D2L_API_LP_VERSION: '1.53',
    ...overrides
  };
}

test('required application and worker configuration accepts missing LTI registration settings', () => {
  const env = validEnvironment();
  assert.equal(validateRequiredEnvironment(env), true);
  assert.equal(ltiConfiguration(env).complete, false);
});

test('partial LTI registration settings stay in setup mode and skip platform registration', async () => {
  const env = validEnvironment({ BS_LTI_CLIENT_ID: 'client-only' });
  assert.equal(validateRequiredEnvironment(env), true);
  const config = ltiConfiguration(env);
  assert.equal(config.complete, false);
  let calls = 0;
  assert.equal(await registerBrightspacePlatform({ registerPlatform: async () => { calls += 1; } }, config), false);
  assert.equal(calls, 0);
});

test('complete LTI registration configuration registers the platform normally', async () => {
  const env = validEnvironment({
    BS_LTI_CLIENT_ID: 'lti-client',
    BS_LTI_DEPLOYMENT_ID: 'deployment',
    BS_LTI_AUTH_ENDPOINT: 'https://tenant.brightspace.com/d2l/lti/authenticate',
    BS_LTI_TOKEN_ENDPOINT: 'https://tenant.brightspace.com/core/connect/token',
    BS_LTI_KEYSET_URL: 'https://tenant.brightspace.com/.well-known/jwks',
    BS_NAME: 'Tenant Brightspace'
  });
  const config = ltiConfiguration(env);
  assert.equal(config.complete, true);
  const registrations = [];
  assert.equal(await registerBrightspacePlatform({ registerPlatform: async value => registrations.push(value) }, config), true);
  assert.deepEqual(registrations, [{
    url: env.BS_URL,
    name: env.BS_NAME,
    clientId: env.BS_LTI_CLIENT_ID,
    authenticationEndpoint: env.BS_LTI_AUTH_ENDPOINT,
    accesstokenEndpoint: env.BS_LTI_TOKEN_ENDPOINT,
    authConfig: { method: 'JWK_SET', key: env.BS_LTI_KEYSET_URL }
  }]);
});

test('OAuth service-account settings and exact LP version setting remain required', () => {
  for (const name of REQUIRED_ENVIRONMENT) {
    const env = validEnvironment();
    delete env[name];
    assert.throws(() => validateRequiredEnvironment(env), new RegExp(name));
  }
  assert.throws(() => validateRequiredEnvironment(validEnvironment({ D2L_API_LP_VERSION: '' })), /D2L_API_LP_VERSION/);
  assert.deepEqual(LTI_ENVIRONMENT, [
    'BS_LTI_CLIENT_ID', 'BS_LTI_DEPLOYMENT_ID', 'BS_LTI_AUTH_ENDPOINT',
    'BS_LTI_TOKEN_ENDPOINT', 'BS_LTI_KEYSET_URL'
  ]);
});

test('public bootstrap routes expose ping and only the supplied public JWKS', () => {
  const routes = new Map();
  const whitelisted = [];
  const provider = {
    whitelist: (...args) => whitelisted.push(...args),
    app: { get: (path, handler) => routes.set(path, handler) }
  };
  const jwks = { keys: [{ kid: 'oauth-key-id', kty: 'RSA', e: 'AQAB', n: 'public-modulus' }] };
  installPublicBootstrapEndpoints(provider, jwks);
  assert.deepEqual(whitelisted.map(({ route }) => route), ['/.well-known/brightspace-jwks.json', '/ping']);
  let result;
  routes.get('/.well-known/brightspace-jwks.json')({}, { json: value => { result = value; } });
  assert.deepEqual(result, jwks);
  assert.equal(JSON.stringify(result).includes('private-key'), false);
  const response = {
    type(value) { this.contentType = value; return this; },
    send(value) { this.body = value; return this; }
  };
  routes.get('/ping')({}, response);
  assert.equal(response.contentType, 'text/plain');
  assert.match(response.body, /running/);
});

test('trigger mode defaults to cron and rejects ambiguous values', () => {
  assert.equal(sectionAssociationTriggerMode({}), 'cron');
  assert.equal(sectionAssociationTriggerMode({ SECTION_ASSOCIATION_FIX_TRIGGER_MODE: 'internal' }), 'internal');
  assert.throws(() => sectionAssociationTriggerMode({ SECTION_ASSOCIATION_FIX_TRIGGER_MODE: 'automatic' }), /must be either cron or internal/);
});

test('cron trigger does not start internal scheduler while internal trigger does', () => {
  let calls = 0;
  const logs = [];
  const scheduler = () => { calls++; return { started: true }; };
  assert.equal(startSectionAssociationTrigger({ mode: 'cron', service: {}, scheduler, logger: { log: value => logs.push(value) } }), null);
  assert.equal(calls, 0);
  assert.equal(startSectionAssociationTrigger({ mode: 'internal', service: {}, scheduler, logger: { log: value => logs.push(value) } }).started, true);
  assert.equal(calls, 1);
  assert.deepEqual(logs, ['[section-association] trigger mode=cron internal scheduler disabled', '[section-association] trigger mode=internal']);
});

test('cron worker validation does not require APP_LTI_SECRET or any LTI registration values', () => {
  const env = Object.fromEntries(['DB_MONGODB_URL','BS_URL','BS_OAUTH2_CLIENT_ID','BS_OAUTH2_PRIVATE_KEY','BS_OAUTH2_KEY_ID',
    'BS_OAUTH2_TOKEN_ENDPOINT','BS_OAUTH2_SCOPES','D2L_API_LP_VERSION','SECTION_ASSOCIATION_FIX_DRY_RUN'].map(key => [key, 'configured']));
  env.D2L_API_LP_VERSION = '1.53';
  assert.equal(validateWorkerEnvironment(env), true);
  delete env.BS_OAUTH2_CLIENT_ID;
  assert.throws(() => validateWorkerEnvironment(env), /BS_OAUTH2_CLIENT_ID/);
});

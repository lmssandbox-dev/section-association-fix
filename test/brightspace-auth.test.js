const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync, createPublicKey, verify } = require('node:crypto');
const { createBrightspaceAuth, logOAuthConfiguration } = require('../src/shared/auth');
const { installPublicBootstrapEndpoints } = require('../src/sectionAssociations/config');
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const config = { clientId: 'test-client', scope: 'test:resource:read', kid: 'test-key',
  privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }) };

test('OAuth diagnostics show known error codes without leaking response secrets', async () => {
  for (const code of ['invalid_client', 'invalid_scope', 'SECRET']) {
    const auth = createBrightspaceAuth({ ...config, http: { async post() {
      throw { response: { status: 400, data: { error: code, error_description: 'SECRET' } } };
    } } });
    await assert.rejects(auth.getAccessToken(), error => {
      assert.ok(!error.message.includes('SECRET'));
      assert.ok(error.message.includes('HTTP 400'));
      if (code !== 'SECRET') assert.ok(error.message.includes(`[${code}]`));
      return true;
    });
  }
});

test('invalid_grant emits only an allowlisted assertion-failure hint', async () => {
  const diagnostics = [];
  const auth = createBrightspaceAuth({ ...config, onDiagnostic: value => diagnostics.push(value), http: { async post() {
    throw { response: { status: 400, data: { error: 'invalid_grant',
      error_description: 'Assertion audience mismatch; PRIVATE RESPONSE DETAIL' } } };
  } } });
  await assert.rejects(auth.getAccessToken(), error => {
    assert.equal(error.protocolCode, 'invalid_grant');
    assert.equal(error.protocolHint, 'assertion-audience-mismatch');
    assert.equal(error.message.includes('PRIVATE RESPONSE DETAIL'), false);
    return true;
  });
  assert.deepEqual(diagnostics, [{ protocolCode: 'invalid_grant', cause: 'assertion-audience-mismatch' }]);
});

test('OAuth startup configuration log contains only safe metadata', () => {
  const lines = [];
  const auth = createBrightspaceAuth({ ...config, http: { async post() {} } });
  logOAuthConfiguration({ clientId: config.clientId, kid: config.kid,
    tokenEndpoint: 'https://auth.brightspace.com/core/connect/token', scope: 'one:two:read three:four:update',
    jwks: auth.jwks, logger: { info: line => lines.push(line) } });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[oauth\] configuration clientIdPresent=true keyId=sha256:[a-f0-9]{12} tokenEndpointHost=auth\.brightspace\.com scopeCount=2 jwksKeyCount=1$/);
  assert.equal(lines[0].includes(config.clientId), false);
  assert.equal(lines[0].includes(config.kid), false);
  assert.equal(lines[0].includes(config.privateKeyPem), false);
});

test('public bootstrap JWKS serves the generated OAuth key id and public key only', () => {
  const auth = createBrightspaceAuth({ ...config, http: { async post() {} } });
  const routes = new Map();
  installPublicBootstrapEndpoints({ whitelist() {}, app: { get: (path, handler) => routes.set(path, handler) } }, auth.jwks);
  let response;
  routes.get('/.well-known/brightspace-jwks.json')({}, { json: value => { response = value; } });
  assert.equal(response.keys.length, 1);
  assert.equal(response.keys[0].kid, config.kid);
  assert.equal(response.keys[0].kty, 'RSA');
  assert.equal(response.keys[0].alg, 'RS256');
  assert.equal(response.keys[0].use, 'sig');
  assert.equal(Object.hasOwn(response.keys[0], 'd'), false);
});

test('signed assertion, public discovery, concurrent cache and renewal', async () => {
  let time = 1000000;
  const calls = [];
  const requestOptions = [];
  const auth = createBrightspaceAuth({ ...config, now: () => time, http: {
    async post(url, body, options) {
      calls.push(new URLSearchParams(body));
      requestOptions.push(options);
      assert.equal(url, 'https://auth.brightspace.com/core/connect/token');
      return { data: { access_token: `token-${calls.length}`, token_type: 'Bearer', expires_in: 1800 } };
    }
  } });
  assert.deepEqual(await Promise.all([auth.getAccessToken(), auth.getAccessToken()]), ['token-1', 'token-1']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].get('grant_type'), 'client_credentials');
  assert.equal(calls[0].get('client_assertion_type'), 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
  assert.equal(calls[0].get('scope'), config.scope);
  assert.equal(calls[0].has('refresh_token'), false);
  assert.equal(requestOptions[0].headers['Content-Type'], 'application/x-www-form-urlencoded');
  const [header, payload, signature] = calls[0].get('client_assertion').split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'RS256', typ: 'JWT', kid: config.kid });
  const claims = JSON.parse(Buffer.from(payload, 'base64url'));
  assert.equal(claims.iss, config.clientId);
  assert.equal(claims.sub, config.clientId);
  assert.equal(claims.aud, 'https://auth.brightspace.com/core/connect/token');
  assert.equal(claims.iat, 1000);
  assert.equal(claims.exp, 1060);
  assert.ok(claims.jti);
  assert.equal(Object.hasOwn(claims, 'kid'), false);
  assert.equal(auth.jwks.keys[0].kid, config.kid);
  assert.equal(auth.jwks.keys[0].kty, 'RSA');
  assert.equal(auth.jwks.keys[0].alg, 'RS256');
  assert.equal(auth.jwks.keys[0].use, 'sig');
  assert.equal(auth.jwks.keys[0].d, undefined);
  assert.ok(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), createPublicKey({ key: auth.jwks.keys[0], format: 'jwk' }), Buffer.from(signature, 'base64url')));
  time += 1739000;
  assert.equal(await auth.getAccessToken(), 'token-1');
  time += 1000;
  assert.equal(await auth.getAccessToken(), 'token-2');
  const second = JSON.parse(Buffer.from(calls[1].get('client_assertion').split('.')[1], 'base64url'));
  assert.notEqual(second.jti, claims.jti);
});

test('failed and malformed exchanges are not cached; errors do not leak credentials', async () => {
  let attempts = 0;
  const auth = createBrightspaceAuth({ ...config, http: { async post() {
    attempts++;
    if (attempts === 1) throw Object.assign(new Error('SECRET'), { response: { status: 401 }, config: { secret: 'SECRET' } });
    if (attempts === 2) return { data: { access_token: 'bad', expires_in: -1 } };
    return { data: { access_token: 'ok', token_type: 'Bearer', expires_in: 300 } };
  } } });
  await assert.rejects(auth.getAccessToken(), { message: 'Brightspace token exchange failed (HTTP 401)' });
  await assert.rejects(auth.getAccessToken(), { message: 'Brightspace token exchange failed' });
  assert.equal(await auth.getAccessToken(), 'ok');
  assert.equal(attempts, 3);
});

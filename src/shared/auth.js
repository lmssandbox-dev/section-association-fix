'use strict';

const { createPrivateKey, createPublicKey, sign, randomUUID } = require('node:crypto');

// http is injected so token exchange can be tested without live credentials.
function createBrightspaceAuth({ clientId, scope, kid, privateKeyPem,
  tokenEndpoint = 'https://auth.brightspace.com/core/connect/token', http,
  now = Date.now }) {
  if (!clientId || !scope || !kid || !privateKeyPem) throw new Error('Incomplete OAuth service-account configuration');
  if (new URL(tokenEndpoint).protocol !== 'https:') throw new Error('OAuth token endpoint must use HTTPS');
  const key = createPrivateKey(privateKeyPem.replace(/\\n/g, '\n'));
  if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength < 2048) {
    throw new Error('Use an RSA private key of at least 2048 bits');
  }
  const publicJwk = { ...createPublicKey(key).export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
  let cachedToken;
  let expiresAt = 0;
  let pending;
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');

  function assertion() {
    const iat = Math.floor(now() / 1000);
    const unsigned = `${encode({ alg: 'RS256', typ: 'JWT', kid })}.${encode({
      iss: clientId, sub: clientId, aud: tokenEndpoint, iat, exp: iat + 60, jti: randomUUID()
    })}`;
    return `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), key).toString('base64url')}`;
  }

  async function exchange() {
    const startedAt = now();
    try {
      const response = await http.post(tokenEndpoint, new URLSearchParams({
        grant_type: 'client_credentials',
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: assertion(), scope
      }).toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000, maxRedirects: 0
      });
      const { access_token, expires_in, token_type } = response.data || {};
      const seconds = Number(expires_in);
      if (typeof access_token !== 'string' || !access_token || !Number.isFinite(seconds) || seconds <= 0 ||
          String(token_type).toLowerCase() !== 'bearer') throw new Error('Invalid token response');
      cachedToken = access_token;
      expiresAt = startedAt + (seconds - Math.min(60, seconds * 0.1)) * 1000;
      return cachedToken;
    } catch (error) {
      // Never propagate Axios request config: it contains the signed assertion.
      const status = error.response?.status;
      const knownErrors = new Set(['invalid_request', 'invalid_client', 'invalid_grant',
        'unauthorized_client', 'unsupported_grant_type', 'invalid_scope', 'server_error',
        'temporarily_unavailable']);
      const code = error.response?.data?.error;
      // Only allow known protocol codes, never arbitrary response text or assertions.
      const detail = knownErrors.has(code) ? ` [${code}]` : '';
      throw new Error(`Brightspace token exchange failed${status ? ` (HTTP ${status})` : ''}${detail}`);
    }
  }

  return {
    jwks: { keys: [publicJwk] },
    async getAccessToken() {
      if (cachedToken && now() < expiresAt) return cachedToken;
      if (!pending) pending = exchange().finally(() => { pending = undefined; });
      return pending;
    }
  };
}

module.exports = { createBrightspaceAuth };

'use strict';

const { createPrivateKey, createPublicKey, sign, randomUUID, createHash } = require('node:crypto');

function classifyAssertionFailure(code, description) {
  if (code !== 'invalid_grant' || typeof description !== 'string') return null;
  const text = description.toLowerCase().replace(/[^a-z0-9_ -]/g, ' ');
  if (/audience.*(invalid|mismatch|incorrect|not valid)|(invalid|mismatch|incorrect).*audience/.test(text)) return 'assertion-audience-mismatch';
  if (/client is not authorized to set.*kid|kid.*not authorized/.test(text)) return 'kid-claim-in-payload';
  if (/(key ?id|kid).*(not found|unknown|missing)|(not found|unknown|missing).*(key ?id|kid)/.test(text)) return 'assertion-key-id-not-found';
  if (/(assertion|jwt).*(expired|exp|iat|issued at|clock|timestamp)|(expired|exp|iat|issued at|clock|timestamp).*(assertion|jwt)/.test(text)) return 'assertion-time-invalid';
  if (/(jti|assertion|jwt).*(replay|reused|already used)|(replay|reused|already used).*(jti|assertion|jwt)/.test(text)) return 'assertion-replay-detected';
  if (/(issuer|client id|client_id).*(invalid|mismatch|unknown|not found)|(invalid|mismatch|unknown|not found).*(issuer|client id|client_id)/.test(text)) return 'assertion-client-id-mismatch';
  return null;
}

function logOAuthConfiguration({ clientId, kid, tokenEndpoint, scope, jwks, logger = console } = {}) {
  let host = 'invalid';
  try { host = new URL(tokenEndpoint).host; } catch {}
  const keyId = typeof kid === 'string' && kid
    ? `sha256:${createHash('sha256').update(kid).digest('hex').slice(0, 12)}` : 'redacted';
  const scopeCount = typeof scope === 'string' ? scope.trim().split(/\s+/).filter(Boolean).length : 0;
  const jwksKeyCount = Array.isArray(jwks?.keys) ? jwks.keys.length : 0;
  logger?.info?.(`[oauth] configuration clientIdPresent=${Boolean(clientId)} keyId=${keyId} tokenEndpointHost=${host} scopeCount=${scopeCount} jwksKeyCount=${jwksKeyCount}`);
}

// http is injected so token exchange can be tested without live credentials.
function createBrightspaceAuth({ clientId, scope, kid, privateKeyPem,
  tokenEndpoint = 'https://auth.brightspace.com/core/connect/token', http,
  now = Date.now, onDiagnostic }) {
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
      const protocolHint = classifyAssertionFailure(code, error.response?.data?.error_description);
      // Only allow known protocol codes, never arbitrary response text or assertions.
      const detail = knownErrors.has(code) ? ` [${code}]` : '';
      const safe = new Error(`Brightspace token exchange failed${status ? ` (HTTP ${status})` : ''}${detail}`);
      safe.code = 'TOKEN_EXCHANGE_FAILED';
      safe.status = Number.isInteger(status) ? status : null;
      safe.protocolCode = knownErrors.has(code) ? code : null;
      safe.protocolHint = protocolHint;
      if (protocolHint) {
        try { onDiagnostic?.({ protocolCode: safe.protocolCode, cause: protocolHint }); } catch {}
      }
      throw safe;
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

module.exports = { createBrightspaceAuth, logOAuthConfiguration, classifyAssertionFailure };

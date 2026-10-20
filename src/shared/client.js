'use strict';

class ApiReadError extends Error {
  constructor(status, fatal = false, details = {}) {
    super('Brightspace API read failed', details.cause ? { cause: details.cause } : undefined);
    this.code = 'API_READ_FAILED';
    this.status = Number.isInteger(status) ? status : null;
    this.fatal = fatal || status === 401 || status === 403 || status === 429 || status === 503 || status == null;
    this.reason = details.reason || 'api-read-failed';
    this.phase = details.phase;
    this.protocolCode = details.protocolCode;
    this.networkCode = details.networkCode;
  }
}

// Keep the service-account token exchange and request safeguards used by the worker.
function createBrightspaceGet({ http, oauth, baseUrl, retries = 0, delay = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  return async function get(path) {
    const url = new URL(path, baseUrl);
    if (url.origin !== new URL(baseUrl).origin || url.protocol !== 'https:') {
      throw new Error('API URL must belong to the configured Brightspace HTTPS origin');
    }
    let token;
    try { token = await oauth.getAccessToken(); }
    catch (error) {
      const safe = new ApiReadError(Number.isInteger(error?.status) ? error.status : null, true, {
        cause: error, reason: 'oauth-failed', phase: 'oauth', protocolCode: error?.protocolCode
      });
      safe.code = 'TOKEN_EXCHANGE_FAILED';
      throw safe;
    }
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await http({ timeout: 15000, maxRedirects: 0, method: 'GET', url: url.href,
          headers: { Authorization: `Bearer ${token}` } });
        return response.data;
      } catch (error) {
        const status = error.response?.status;
        if (attempt >= Math.min(retries, 2) || !(status == null || status === 429 || status >= 500)) throw error;
        const retryAfter = error.response?.headers?.['retry-after'];
        const wait = retryAfter == null ? 500 * 2 ** attempt + Math.floor(Math.random() * 200)
          : /^\d+(\.\d+)?$/.test(String(retryAfter)) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now();
        if (!Number.isFinite(wait) || wait > 5000) throw error;
        await delay(Math.max(0, wait));
      }
    }
  };
}

// Require exact resource-group/action matches while supporting D2L action wildcards.
function hasScope(scopes, required) {
  if (typeof scopes !== 'string' || typeof required !== 'string') return false;
  const target = required.split(':');
  if (target.length !== 3 || target.some(part => !/^[A-Za-z][A-Za-z0-9]*$/.test(part))) return false;
  return scopes.trim().split(/\s+/).some(scope => {
    const parts = scope.split(':');
    if (parts.length !== 3 || parts[0] !== target[0]) return false;
    if (parts[1] !== '*' && parts[1] !== target[1]) return false;
    if (parts[2] === '*') return true;
    const actions = parts[2].split(',');
    return actions.every(action => /^[A-Za-z][A-Za-z0-9]*$/.test(action)) && actions.includes(target[2]);
  });
}

module.exports = { createBrightspaceGet, ApiReadError, hasScope };

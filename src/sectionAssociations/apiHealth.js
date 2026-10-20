'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { API_HEALTH_INVENTORY, AUTHENTICATION_DIAGNOSTIC, LIFECYCLE, LIFECYCLE_EVIDENCE_MAX_AGE_DAYS,
  VERSION_CHECK_DOCS, API_PROPERTIES_DOCS, ROUTING_TABLE_DOCS } = require('./apiHealthInventory');

const DAILY_AFTER_MINUTE = 120;
const HEALTH_LEASE_MS = 5 * 60 * 1000;
const MANUAL_COOLDOWN_MS = 5 * 60 * 1000;
const HISTORY_LIMIT = 30;
const STALE_AFTER_MS = 36 * 60 * 60 * 1000;
const versionPattern = /^\d+\.\d+$/;

function versionParts(value) {
  if (typeof value !== 'string' || !versionPattern.test(value)) return null;
  return value.split('.').map(Number);
}
function compareVersions(a, b) {
  const left = versionParts(a), right = versionParts(b);
  if (!left || !right) return null;
  return left[0] - right[0] || left[1] - right[1];
}
function validVersionList(value) {
  return Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'string' && versionPattern.test(item));
}
function extractVersionsResponse(response) {
  const product = Array.isArray(response) ? response.find(item => item?.ProductCode === 'lp')
    : response?.ProductCode === 'lp' ? response : null;
  if (!product || typeof product.LatestVersion !== 'string' || !versionPattern.test(product.LatestVersion) ||
      !validVersionList(product.SupportedVersions)) throw Object.assign(new Error('Invalid tenant version response.'), { code: 'INVALID_VERSION_RESPONSE' });
  return { latestVersion: product.LatestVersion, supportedVersions: [...new Set(product.SupportedVersions)] };
}
function extractCheckResponse(response, configuredVersion) {
  const item = response?.Versions?.find(candidate => candidate?.ProductCode === 'lp' && candidate?.Version === configuredVersion);
  if (typeof response?.Supported !== 'boolean' || typeof item?.Supported !== 'boolean' ||
      typeof item?.LatestVersion !== 'string' || !versionPattern.test(item.LatestVersion)) {
    throw Object.assign(new Error('Invalid tenant version-check response.'), { code: 'INVALID_VERSION_CHECK_RESPONSE' });
  }
  return { supported: item.Supported, latestVersion: item.LatestVersion };
}
function evidenceIsCurrent(now, date = LIFECYCLE.verifiedAt) {
  const age = now - Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(age) && age >= 0 && age <= LIFECYCLE_EVIDENCE_MAX_AGE_DAYS * 86400000;
}
function classifyVersion({ configuredVersion, latestVersion, supported, supportedVersions, now, evidenceDate = LIFECYCLE.verifiedAt }) {
  if (!versionParts(configuredVersion) || !versionParts(latestVersion) || typeof supported !== 'boolean' || !validVersionList(supportedVersions)) {
    return { status: 'Unknown', explanation: 'Tenant version evidence is incomplete.' };
  }
  if (supported === false || !supportedVersions.includes(configuredVersion)) {
    return { status: 'Critical', explanation: 'The tenant does not support the configured LP version.' };
  }
  if (!evidenceIsCurrent(now, evidenceDate)) return { status: 'Unknown', explanation: 'Lifecycle evidence is missing or stale.' };
  const obsoleteComparison = compareVersions(configuredVersion, '1.46');
  if (obsoleteComparison === null) return { status: 'Unknown', explanation: 'The configured version cannot be compared with lifecycle evidence.' };
  if (obsoleteComparison < 0) return { status: 'Critical', explanation: 'D2L lifecycle guidance marks this contract range obsolete.' };
  if (compareVersions(configuredVersion, '1.49') < 0) return { status: 'At Risk', explanation: 'D2L lifecycle guidance marks this contract range deprecated.' };
  if (compareVersions(configuredVersion, latestVersion) < 0) return { status: 'Update Available', explanation: 'A newer LP version is supported by this tenant.' };
  return { status: 'Healthy', explanation: 'The configured LP version is supported and current lifecycle evidence shows no documented version risk.' };
}
function summarizeFailure(error, now) {
  const status = Number.isInteger(error?.response?.status) ? error.response.status : null;
  const code = /^[A-Z][A-Z0-9_]{0,63}$/.test(String(error?.code || '')) ? error.code : 'API_HEALTH_CHECK_FAILED';
  return { status: 'Unknown', attemptedAt: new Date(now).toISOString(), errorCode: code, httpStatus: status };
}
function inventoryRevision() {
  return createHash('sha256').update(JSON.stringify({ inventory: API_HEALTH_INVENTORY, lifecycle: LIFECYCLE })).digest('hex').slice(0, 16);
}
function endpointResults(status, configuredVersion, explanation) {
  return API_HEALTH_INVENTORY.map(endpoint => ({ ...endpoint, configuredVersion: configuredVersion || null,
    versionHealth: status, riskExplanation: endpoint.compatibilityRisk || explanation,
    documentation: endpoint.docs }));
}

function createApiHealthService({ get, http, oauth, baseUrl, configuredVersion, store, now = Date.now, logger = console,
  lifecycleEvidence = LIFECYCLE }) {
  if (typeof get !== 'function' || typeof http !== 'function' || !oauth?.getAccessToken || !store) throw new Error('API Health Check dependencies are required.');
  const root = new URL(baseUrl);
  if (root.protocol !== 'https:' || root.username || root.password || root.search || root.hash) throw new Error('Brightspace base URL must be a clean HTTPS origin.');
  const revision = inventoryRevision();

  async function assess() {
    const configured = typeof configuredVersion === 'string' && versionPattern.test(configuredVersion) ? configuredVersion : null;
    if (!configured) throw Object.assign(new Error('Configured LP version is unavailable.'), { code: 'CONFIGURED_VERSION_INVALID' });
    const versions = extractVersionsResponse(await get(new URL('/d2l/api/lp/versions/', root).href));
    const token = await oauth.getAccessToken();
    const target = new URL('/d2l/api/versions/check', root);
    const checked = await http({ method: 'POST', url: target.href, data: [{ ProductCode: 'lp', Version: configured }],
      timeout: 15000, maxRedirects: 0, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
    const check = extractCheckResponse(checked?.data, configured);
    const assessedAt = now();
    let versionHealth = classifyVersion({ configuredVersion: configured, latestVersion: versions.latestVersion,
      supported: check.supported, supportedVersions: versions.supportedVersions, now: assessedAt, evidenceDate: lifecycleEvidence.verifiedAt });
    const endpoints = API_HEALTH_INVENTORY.map(endpoint => {
      const belowMinimum = versionHealth.status !== 'Unknown' && endpoint.minimumVersion && compareVersions(configured, endpoint.minimumVersion) < 0;
      return { ...endpoint, configuredVersion: configured, versionHealth: belowMinimum ? 'Critical' : versionHealth.status,
        riskExplanation: belowMinimum ? `Configured LP ${configured} is below the verified minimum ${endpoint.minimumVersion}.` :
          endpoint.compatibilityRisk || versionHealth.explanation, documentation: endpoint.docs };
    });
    if (endpoints.some(endpoint => endpoint.versionHealth === 'Critical') && versionHealth.status !== 'Unknown') {
      versionHealth = { status: 'Critical', explanation: 'The configured LP version is below a verified minimum required by at least one application operation.' };
    }
    for (const endpoint of endpoints) if (endpoint.versionHealth === 'Critical' && endpoint.minimumVersion &&
      compareVersions(configured, endpoint.minimumVersion) < 0) endpoint.riskExplanation = `Configured LP ${configured} is below the verified minimum ${endpoint.minimumVersion}.`;
    const counts = Object.fromEntries(['Healthy', 'Update Available', 'At Risk', 'Critical', 'Unknown']
      .map(status => [status, endpoints.filter(endpoint => endpoint.versionHealth === status).length]));
    return { assessmentId: randomUUID(), assessedAt: new Date(assessedAt), inventoryRevision: revision,
      applicationBuild: process.env.npm_package_version || null, configuredVersion: configured,
      latestSupportedVersion: versions.latestVersion, supportedVersions: versions.supportedVersions,
      tenantSupported: check.supported, versionHealth: versionHealth.status, explanation: versionHealth.explanation,
      contractVerification: 'Not Verified', authenticationDiagnostic: AUTHENTICATION_DIAGNOSTIC,
      lifecycleEvidence: { ...lifecycleEvidence, maxAgeDays: LIFECYCLE_EVIDENCE_MAX_AGE_DAYS },
      documentation: { versionCheck: VERSION_CHECK_DOCS, apiProperties: API_PROPERTIES_DOCS, routingTable: ROUTING_TABLE_DOCS },
      counts, endpoints };
  }

  async function run(mode = 'manual') {
    const lease = await store.acquireApiHealthLease(mode, HEALTH_LEASE_MS, MANUAL_COOLDOWN_MS, now());
    if (!lease?.token) return { status: lease?.reason || 'busy', retryAfter: lease?.retryAfter || null };
    const attemptedAt = new Date(now());
    try {
      const result = await assess();
      await store.saveApiHealthResult(lease.token, mode, { status: 'success', attemptedAt, assessment: result });
      return { status: 'completed', assessment: result };
    } catch (error) {
      const failure = summarizeFailure(error, now());
      try { await store.saveApiHealthResult(lease.token, mode, { status: 'failed', attemptedAt, failure,
        inventoryRevision: revision }); } catch { /* Health diagnostics must not escape into reconciliation. */ }
      logger.warn?.(`[api-health] assessment failed code=${failure.errorCode} httpStatus=${failure.httpStatus ?? 'unknown'}`);
      return { status: 'failed', failure };
    }
  }
  async function runIfDue() {
    const current = new Date(now());
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(current);
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    if (Number(values.hour) * 60 + Number(values.minute) < DAILY_AFTER_MINUTE) return { status: 'not-due' };
    const state = await store.getApiHealthState();
    const today = `${values.year}-${values.month}-${values.day}`;
    const lastAuto = state?.lastAutomaticAttemptAt instanceof Date ? state.lastAutomaticAttemptAt.toISOString() : '';
    if (lastAuto.slice(0, 10) === today) return { status: 'not-due' };
    return run('automatic');
  }
  async function getCached() {
    const state = await store.getApiHealthState();
    const successful = state?.latestSuccessful || null;
    const assessedAt = successful?.assessedAt instanceof Date ? successful.assessedAt.getTime() : Date.parse(successful?.assessedAt || '');
    const stale = !successful || !Number.isFinite(assessedAt) || now() - assessedAt > STALE_AFTER_MS ||
      successful.inventoryRevision !== revision;
    const failedSinceSuccess = state?.lastAttemptStatus === 'failed' &&
      (!successful || new Date(state.lastAttemptAt).getTime() >= assessedAt);
    const currentStatus = stale || failedSinceSuccess ? 'Unknown' : state?.currentHealth?.status || successful.versionHealth;
    const currentEvidence = Boolean(successful && successful.inventoryRevision === revision && !stale && !failedSinceSuccess);
    const unknownEndpoints = endpointResults('Unknown', configuredVersion || null,
      stale ? 'No current assessment is available. Run Check to refresh tenant evidence.' : 'The latest assessment failed; retry the check to refresh current health.');
    return { configuredVersion: configuredVersion || null, latestSuccessful: successful,
      currentStatus, stale, staleAfterHours: 36, lastAttemptAt: state?.lastAttemptAt || null,
      lastAttemptMode: state?.lastAttemptMode || null, lastAttemptStatus: state?.lastAttemptStatus || null,
      lastFailure: state?.lastFailure || null, history: state?.history || [], inventoryRevision: revision,
      endpoints: currentEvidence ? successful.endpoints : unknownEndpoints,
      counts: currentEvidence ? successful.counts : { Healthy: 0, 'Update Available': 0, 'At Risk': 0, Critical: 0, Unknown: API_HEALTH_INVENTORY.length } };
  }
  return { assess, run, runIfDue, inventory: API_HEALTH_INVENTORY, inventoryRevision: revision, getCached,
    async runManual() { return run('manual'); } };
}

module.exports = { createApiHealthService, classifyVersion, compareVersions, extractVersionsResponse, extractCheckResponse,
  evidenceIsCurrent, inventoryRevision, DAILY_AFTER_MINUTE, HEALTH_LEASE_MS, MANUAL_COOLDOWN_MS, HISTORY_LIMIT, STALE_AFTER_MS };

'use strict';

const ID = /^[1-9]\d*$/;
const { ApiReadError } = require('../shared/client');

function createSectionAssociationClient({ get, http, oauth, baseUrl, lpVersion }) {
  const origin = new URL(baseUrl);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash) {
    throw new Error('Brightspace base URL must be a clean HTTPS origin.');
  }
  if (!/^\d+\.\d+$/.test(lpVersion || '')) throw new Error('Configure D2L_API_LP_VERSION.');
  const root = `/d2l/api/lp/${lpVersion}`;
  const url = path => new URL(path, origin).href;
  const getPage = async (target, endpoint = 'brightspace-api') => {
    try { return await get(target); }
    catch (error) {
      if (error?.code === 'TOKEN_EXCHANGE_FAILED' || error?.code === 'API_READ_FAILED') {
        error.endpoint ||= error.code === 'TOKEN_EXCHANGE_FAILED' ? 'oauth-token' : endpoint;
        error.phase ||= endpoint === 'association-candidates' ? 'discovery' : 'reconciliation';
        throw error;
      }
      if (error?.phase === 'database') {
        const safe = new Error('Section Association database operation failed');
        safe.code = error.code ?? error.codeName ?? 'DATABASE_OPERATION_FAILED';
        safe.phase = 'database';
        throw safe;
      }
      const status = Number.isInteger(error?.response?.status) ? error.response.status : null;
      const networkCode = typeof error?.code === 'string' && /^(?:ETIMEDOUT|ECONNABORTED|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH)$/.test(error.code) ? error.code : null;
      const safe = new ApiReadError(status, false, { cause: error,
        reason: status != null ? 'api-read-failed' : networkCode === 'ETIMEDOUT' || networkCode === 'ECONNABORTED' ? 'api-timeout' : networkCode ? 'api-network-failed' : 'api-read-failed',
        phase: endpoint === 'association-candidates' ? 'discovery' : 'reconciliation', networkCode });
      safe.endpoint = endpoint;
      throw safe;
    }
  };
  const read = async (path, endpoint) => getPage(url(path), endpoint);
  const pages = async (path, endpoint) => {
    let next = url(path);
    const seen = new Set();
    const values = [];
    while (next) {
      if (seen.has(next) || seen.size >= 10000 || values.length >= 1000000) throw new Error('Brightspace pagination limit exceeded.');
      seen.add(next);
      const page = await getPage(next, endpoint);
      if (!page || !Array.isArray(page.Items) || !page.PagingInfo || typeof page.PagingInfo.HasMoreItems !== 'boolean') {
        const error = new Error('Invalid Brightspace paging response.');
        error.responseShape = safeResponseShape(page);
        throw error;
      }
      values.push(...page.Items);
      if (values.length > 1000000) throw new Error('Brightspace result limit exceeded.');
      if (!page.PagingInfo.HasMoreItems) break;
      const bookmark = page.PagingInfo.Bookmark;
      if ((typeof bookmark !== 'string' && typeof bookmark !== 'number') || String(bookmark) === '') {
        const error = new Error('Missing Brightspace paging bookmark.');
        error.responseShape = safeResponseShape(page);
        throw error;
      }
      const current = new URL(next);
      current.searchParams.set('bookmark', String(bookmark));
      next = current.href;
    }
    return values;
  };
  const orgUnit = id => {
    if (!ID.test(String(id))) throw new Error('Invalid org unit ID.');
    return read(`${root}/orgstructure/${id}`, 'association-detail');
  };
  const course = id => {
    if (!ID.test(String(id))) throw new Error('Invalid Course Offering ID.');
    return read(`${root}/courses/${id}`, 'course-offering');
  };
  const associationCandidates = (orgUnitCode = 'I0001') => {
    if (typeof orgUnitCode !== 'string' || !/^(?:\d{4}-)?I0001$/.test(orgUnitCode)) {
      throw new Error('Invalid Section Association discovery code.');
    }
    return pages(`${root}/orgstructure/?orgUnitType=3&orgUnitCode=${encodeURIComponent(orgUnitCode)}`, 'association-candidates');
  };
  const children = id => pages(`${root}/orgstructure/${id}/children/paged/`, 'orgstructure-children');
  const exactCode = code => pages(`${root}/orgstructure/?exactOrgUnitCode=${encodeURIComponent(code)}`, 'exact-org-code');

  // This writer is intentionally limited to Course Offering active-state updates.
  async function putCourse(id, payload) {
    if (!ID.test(String(id))) throw new Error('Invalid Course Offering ID.');
    const target = url(`${root}/courses/${id}`);
    if (new URL(target).origin !== origin.origin || new URL(target).pathname !== `${root}/courses/${id}`) {
      throw new Error('Only Course Offering records can be updated.');
    }
    let token;
    try { token = await oauth.getAccessToken(); }
    catch (error) {
      const safe = new Error('Brightspace OAuth token request failed.');
      safe.code = 'TOKEN_EXCHANGE_FAILED'; safe.reason = 'oauth-failed';
      safe.status = Number.isInteger(error?.status) ? error.status : null;
      safe.protocolCode = error?.protocolCode;
      throw safe;
    }
    try {
      await http({ method: 'PUT', url: target, data: payload, timeout: 15000, maxRedirects: 0,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
    } catch (error) {
      const safe = new Error('Course Offering update failed.');
      safe.code = 'API_UPDATE_FAILED'; safe.reason = 'api-update-failed'; safe.endpoint = 'course-offering'; safe.phase = 'reconciliation';
      safe.status = Number.isInteger(error.response?.status) ? error.response.status : null;
      if (safe.status == null) {
        safe.networkCode = typeof error?.code === 'string' && /^(?:ETIMEDOUT|ECONNABORTED|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH)$/.test(error.code) ? error.code : null;
        safe.reason = safe.networkCode === 'ETIMEDOUT' || safe.networkCode === 'ECONNABORTED' ? 'api-timeout' : safe.networkCode ? 'api-network-failed' : 'api-update-failed';
      }
      safe.uncertain = safe.status == null || safe.status >= 500;
      throw safe;
    }
  }

  return { associationCandidates, orgUnit, children, exactCode, course, putCourse };
}

function safeResponseShape(value) {
  if (value === null) return { responseType: 'null' };
  if (Array.isArray(value)) return { responseType: 'array', itemCount: value.length };
  if (typeof value !== 'object') return { responseType: typeof value };
  const shape = { responseType: 'object', hasItems: Array.isArray(value.Items), hasPagingInfo: Boolean(value.PagingInfo) };
  if (Array.isArray(value.Items)) shape.itemCount = value.Items.length;
  return shape;
}

module.exports = { createSectionAssociationClient };

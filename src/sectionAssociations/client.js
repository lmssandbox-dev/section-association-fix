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
  const getPage = async target => {
    try { return await get(target); }
    catch (error) {
      if (error?.code === 'TOKEN_EXCHANGE_FAILED' || error?.code === 'API_READ_FAILED') throw error;
      if (error?.phase === 'database') {
        const safe = new Error('Section Association database operation failed');
        safe.code = error.code ?? error.codeName ?? 'DATABASE_OPERATION_FAILED';
        safe.phase = 'database';
        throw safe;
      }
      const safe = new ApiReadError(Number.isInteger(error?.response?.status) ? error.response.status : null);
      safe.phase = 'discovery';
      safe.endpoint = 'association-candidates';
      throw safe;
    }
  };
  const read = async path => getPage(url(path));
  const pages = async path => {
    let next = url(path);
    const seen = new Set();
    const values = [];
    while (next) {
      if (seen.has(next) || seen.size >= 10000 || values.length >= 1000000) throw new Error('Brightspace pagination limit exceeded.');
      seen.add(next);
      const page = await getPage(next);
      if (!page || !Array.isArray(page.Items) || !page.PagingInfo || typeof page.PagingInfo.HasMoreItems !== 'boolean') throw new Error('Invalid Brightspace paging response.');
      values.push(...page.Items);
      if (values.length > 1000000) throw new Error('Brightspace result limit exceeded.');
      if (!page.PagingInfo.HasMoreItems) break;
      const bookmark = page.PagingInfo.Bookmark;
      if ((typeof bookmark !== 'string' && typeof bookmark !== 'number') || String(bookmark) === '') throw new Error('Missing Brightspace paging bookmark.');
      const current = new URL(next);
      current.searchParams.set('bookmark', String(bookmark));
      next = current.href;
    }
    return values;
  };
  const orgUnit = id => {
    if (!ID.test(String(id))) throw new Error('Invalid org unit ID.');
    return read(`${root}/orgstructure/${id}`);
  };
  const course = id => {
    if (!ID.test(String(id))) throw new Error('Invalid Course Offering ID.');
    return read(`${root}/courses/${id}`);
  };
  const associationCandidates = () => pages(`${root}/orgstructure/?orgUnitType=3&orgUnitCode=I0001`);
  const children = id => pages(`${root}/orgstructure/${id}/children/paged/`);
  const exactCode = code => pages(`${root}/orgstructure/?exactOrgUnitCode=${encodeURIComponent(code)}`);

  // This writer is intentionally limited to Course Offering active-state updates.
  async function putCourse(id, payload) {
    if (!ID.test(String(id))) throw new Error('Invalid Course Offering ID.');
    const target = url(`${root}/courses/${id}`);
    if (new URL(target).origin !== origin.origin || new URL(target).pathname !== `${root}/courses/${id}`) {
      throw new Error('Only Course Offering records can be updated.');
    }
    const token = await oauth.getAccessToken();
    try {
      await http({ method: 'PUT', url: target, data: payload, timeout: 15000, maxRedirects: 0,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
    } catch (error) {
      const safe = new Error('Course Offering update failed.');
      safe.status = Number.isInteger(error.response?.status) ? error.response.status : null;
      safe.uncertain = safe.status == null || safe.status >= 500;
      throw safe;
    }
  }

  return { associationCandidates, orgUnit, children, exactCode, course, putCourse };
}

module.exports = { createSectionAssociationClient };

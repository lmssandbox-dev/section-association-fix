'use strict';

const EVIDENCE_VERIFIED_AT = '2026-11-09';
const LIFECYCLE_EVIDENCE_MAX_AGE_DAYS = 90;
const LIFECYCLE = {
  source: 'https://docs.valence.desire2learn.com/about.html',
  deprecatedBefore: '1.49',
  obsoleteBefore: '1.46',
  verifiedAt: EVIDENCE_VERIFIED_AT
};

const API_HEALTH_INVENTORY = Object.freeze([
  { id: 'association-discovery', method: 'GET', route: '/d2l/api/lp/{LP}/orgstructure/', component: 'lp',
    versionSource: 'D2L_API_LP_VERSION', minimumVersion: '1.49', purpose: 'Discover Section Association Course Offerings by orgUnitCode.',
    oauthScope: 'organizations:organization:read', contractVerification: 'Not Verified', compatibilityRisk: 'The route appears in LP 1.49+; older contracts are deprecated or obsolete.',
    docs: ['https://docs.valence.desire2learn.com/res/orgunit.html'], evidenceVerifiedAt: EVIDENCE_VERIFIED_AT },
  { id: 'association-exact-resolution', method: 'GET', route: '/d2l/api/lp/{LP}/orgstructure/', component: 'lp',
    versionSource: 'D2L_API_LP_VERSION', minimumVersion: '1.49', purpose: 'Resolve a Course Offering by exactOrgUnitCode.',
    oauthScope: 'organizations:organization:read', contractVerification: 'Not Verified', compatibilityRisk: 'The route appears in LP 1.49+; older contracts are deprecated or obsolete.',
    docs: ['https://docs.valence.desire2learn.com/res/orgunit.html'], evidenceVerifiedAt: EVIDENCE_VERIFIED_AT },
  { id: 'org-unit-details', method: 'GET', route: '/d2l/api/lp/{LP}/orgstructure/{id}', component: 'lp',
    versionSource: 'D2L_API_LP_VERSION', minimumVersion: '1.49', purpose: 'Read the association Course Offering organizational-unit details.',
    oauthScope: 'organizations:organization:read', contractVerification: 'Not Verified', compatibilityRisk: 'The route appears in LP 1.49+; older contracts are deprecated or obsolete.',
    docs: ['https://docs.valence.desire2learn.com/res/orgunit.html'], evidenceVerifiedAt: EVIDENCE_VERIFIED_AT },
  { id: 'direct-group-children', method: 'GET', route: '/d2l/api/lp/{LP}/orgstructure/{id}/children/paged/', component: 'lp',
    versionSource: 'D2L_API_LP_VERSION', minimumVersion: '1.49', purpose: 'Read direct Group children of an association offering.',
    oauthScope: 'organizations:organization:read', contractVerification: 'Not Verified', compatibilityRisk: 'The route appears in LP 1.49+; older contracts are deprecated or obsolete.',
    docs: ['https://docs.valence.desire2learn.com/res/orgunit.html'], evidenceVerifiedAt: EVIDENCE_VERIFIED_AT },
  { id: 'course-offering-read', method: 'GET', route: '/d2l/api/lp/{LP}/courses/{id}', component: 'lp',
    versionSource: 'D2L_API_LP_VERSION', minimumVersion: '1.49', purpose: 'Read original Course Offering details and verify current state.',
    oauthScope: 'orgunits:course:read', contractVerification: 'Not Verified', compatibilityRisk: 'The route appears in LP 1.49+; older contracts are deprecated or obsolete.',
    docs: ['https://docs.valence.desire2learn.com/res/course.html'], evidenceVerifiedAt: EVIDENCE_VERIFIED_AT },
  { id: 'course-offering-update', method: 'PUT', route: '/d2l/api/lp/{LP}/courses/{id}', component: 'lp',
    versionSource: 'D2L_API_LP_VERSION', minimumVersion: '1.49', purpose: 'Set IsActive=false on an eligible original Course Offering.',
    oauthScope: 'orgunits:course:update', contractVerification: 'Not Verified', compatibilityRisk: 'The update route first appears in LP 1.49. D2L documents the LP 1.59 IsActive requirement for CourseOffering creation, not as a minimum for this PUT.',
    docs: ['https://docs.valence.desire2learn.com/res/course.html'], evidenceVerifiedAt: EVIDENCE_VERIFIED_AT }
]);

const AUTHENTICATION_DIAGNOSTIC = Object.freeze({ id: 'oauth-service-account-token-exchange', kind: 'OAuth 2.0 service-account token exchange',
  endpointSource: 'BS_OAUTH2_TOKEN_ENDPOINT', component: 'authentication', versionedBrightspaceApi: false,
  purpose: 'Acquire the service-account bearer token used by tenant API requests; assess authentication separately from LP/LE contract version health.' });

const DIAGNOSTIC_OPERATIONS = Object.freeze([
  { id: 'lp-version-list', method: 'GET', route: '/d2l/api/lp/versions/', component: 'lp-diagnostic',
    purpose: 'Read tenant-supported LP versions for the API Health Check; not a reconciliation operation.', docs: ['https://docs.valence.desire2learn.com/basic/version.html'] },
  { id: 'version-support-check', method: 'POST', route: '/d2l/api/versions/check', component: 'version-diagnostic',
    purpose: 'Check whether the configured LP version is supported; this native version-check POST does not mutate Course Offerings.', docs: ['https://docs.valence.desire2learn.com/basic/version.html'] }
]);

const VERSION_CHECK_DOCS = 'https://docs.valence.desire2learn.com/basic/version.html';
const API_PROPERTIES_DOCS = 'https://docs.valence.desire2learn.com/res/apiprop.html';
const ROUTING_TABLE_DOCS = 'https://docs.valence.desire2learn.com/http-routingtable.html';
const OAUTH_SCOPES_DOCS = 'https://docs.valence.desire2learn.com/http-scopestable.html';

module.exports = { API_HEALTH_INVENTORY, AUTHENTICATION_DIAGNOSTIC, DIAGNOSTIC_OPERATIONS, EVIDENCE_VERIFIED_AT, LIFECYCLE, LIFECYCLE_EVIDENCE_MAX_AGE_DAYS,
  VERSION_CHECK_DOCS, API_PROPERTIES_DOCS, ROUTING_TABLE_DOCS, OAUTH_SCOPES_DOCS };

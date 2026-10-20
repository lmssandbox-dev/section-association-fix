'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSectionAssociationClient } = require('../src/sectionAssociations/client');
const { createSectionAssociationStore } = require('../src/sectionAssociations/store');
const { API_HEALTH_INVENTORY, AUTHENTICATION_DIAGNOSTIC } = require('../src/sectionAssociations/apiHealthInventory');
const { createApiHealthService, classifyVersion, extractVersionsResponse, extractCheckResponse,
  inventoryRevision, STALE_AFTER_MS } = require('../src/sectionAssociations/apiHealth');

const now = Date.parse('2026-10-19T16:00:00.000Z');
const tenantVersions = { ProductCode: 'lp', LatestVersion: '1.64', SupportedVersions: ['1.49','1.53','1.59','1.64'] };

test('endpoint inventory covers all six actual logical client operations and five route shapes', async () => {
  const requests = [];
  const client = createSectionAssociationClient({ baseUrl: 'https://tenant.example', lpVersion: '1.59', oauth: { async getAccessToken() { return 'token'; } },
    async get(url) { requests.push({ method: 'GET', url: new URL(url) }); return { Items: [], PagingInfo: { HasMoreItems: false } }; },
    async http(request) { requests.push({ method: request.method, url: new URL(request.url) }); return {}; } });
  await client.associationCandidates('I0001'); await client.exactCode('2601-ABC');
  await client.orgUnit('123'); await client.children('123'); await client.course('456'); await client.putCourse('456', { IsActive: false });
  const actual = requests.map(({ method, url }) => `${method} ${url.pathname.replace('/1.59/', '/{LP}/')
    .replace(/\/orgstructure\/\d+/g, '/orgstructure/{id}').replace(/\/courses\/\d+/g, '/courses/{id}')}`);
  const inventory = API_HEALTH_INVENTORY.map(item => `${item.method} ${item.route}`);
  assert.equal(API_HEALTH_INVENTORY.length, 6);
  assert.equal(AUTHENTICATION_DIAGNOSTIC.endpointSource, 'BS_OAUTH2_TOKEN_ENDPOINT');
  assert.equal(AUTHENTICATION_DIAGNOSTIC.versionedBrightspaceApi, false);
  assert.equal(new Set(inventory).size, 5);
  for (const route of actual) assert.ok(inventory.includes(route), `missing inventory entry for ${route}`);
  assert.equal(requests.filter(item => item.method === 'PUT').length, 1);
  assert.equal(requests[0].url.searchParams.get('orgUnitCode'), 'I0001');
  assert.equal(requests[1].url.searchParams.get('exactOrgUnitCode'), '2601-ABC');
  assert.equal(inventoryRevision().length, 16);
});

test('version service response formats are validated and LP check response is selected by component and version', () => {
  assert.deepEqual(extractVersionsResponse(tenantVersions), { latestVersion: '1.64', supportedVersions: tenantVersions.SupportedVersions });
  assert.deepEqual(extractCheckResponse({ Supported: true, Versions: [{ ProductCode: 'lp', Version: '1.59', Supported: true, LatestVersion: '1.64' }] }, '1.59'),
    { supported: true, latestVersion: '1.64' });
  assert.throws(() => extractVersionsResponse({ ProductCode: 'lp', LatestVersion: 'x', SupportedVersions: [] }), /Invalid tenant version/);
  assert.throws(() => extractCheckResponse({ Supported: true, Versions: [] }, '1.59'), /Invalid tenant version-check/);
});

test('automatic assessment only becomes due after 02:00 once per Sao Paulo calendar day', async () => {
  let assessCalls=0;
  const state={lastAutomaticAttemptAt:new Date('2026-10-19T12:00:00.000Z')};
  const service=createApiHealthService({baseUrl:'https://tenant.example',configuredVersion:'1.64',store:{async getApiHealthState(){return state},
    async acquireApiHealthLease(){assessCalls++;state.lastAutomaticAttemptAt=new Date(now);return{reason:'busy'}}},now:()=>now,
    oauth:{async getAccessToken(){return'token'}},async get(){return tenantVersions},async http(){return{}},logger:{warn(){}}});
  assert.equal((await service.runIfDue()).status,'not-due');
  state.lastAutomaticAttemptAt=new Date('2026-10-18T12:00:00.000Z');
  assert.equal((await service.runIfDue()).status,'busy');assert.equal(assessCalls,1);
});

test('version classifications distinguish tenant support, lifecycle, newer versions, and incomplete evidence', () => {
  const assess = (version, latest = '1.64', supported = true, supportedVersions = [version, latest], verifiedAt = '2026-10-19') =>
    classifyVersion({ configuredVersion: version, latestVersion: latest, supported, supportedVersions, now, evidenceDate: verifiedAt }).status;
  assert.equal(assess('1.64'), 'Healthy');
  assert.equal(assess('1.59'), 'Update Available');
  assert.equal(assess('1.48'), 'At Risk');
  assert.equal(assess('1.45'), 'Critical');
  assert.equal(assess('1.53', '1.64', false), 'Critical');
  assert.equal(assess('1.64', '1.64', true, ['1.64'], '2025-01-01'), 'Unknown');
  assert.equal(assess('1.64', '1.64', null), 'Unknown');
});

test('assessment checks LP support, lifecycle, endpoint minimums, and does not perform a course update', async () => {
  const calls = [];
  const state = { latestSuccessful: null, history: [] };
  const store = { async acquireApiHealthLease() { return { token: 'lease' }; }, async getApiHealthState() { return state; },
    async saveApiHealthResult(_token, _mode, result) { state.lastAttemptAt = result.attemptedAt; state.lastAttemptStatus = result.status;
      if (result.status === 'success') { state.latestSuccessful = result.assessment; state.currentHealth = { status: result.assessment.versionHealth }; state.history.push(result.assessment); }
    } };
  const service = createApiHealthService({ baseUrl: 'https://tenant.example', configuredVersion: '1.53', store, now: () => now,
    oauth: { async getAccessToken() { return 'private-token'; } },
    async get(url) { calls.push({ method: 'GET', url }); return tenantVersions; },
    async http(request) { calls.push(request); return { data: { Supported: true, Versions: [{ ProductCode: 'lp', Version: '1.53', Supported: true, LatestVersion: '1.64' }] } }; },
    logger: { warn() {} } });
  const result = await service.runManual();
  assert.equal(result.status, 'completed');
  assert.equal(result.assessment.versionHealth, 'Critical');
  assert.equal(result.assessment.endpoints.find(endpoint => endpoint.id === 'course-offering-update').versionHealth, 'Critical');
  assert.equal(result.assessment.endpoints.find(endpoint => endpoint.id === 'course-offering-read').minimumVersion, '1.49');
  assert.equal(result.assessment.contractVerification, 'Not Verified');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].method, 'POST'); assert.match(calls[1].url, /\/d2l\/api\/versions\/check$/);
  assert.equal(calls.some(call => call.method === 'PUT'), false);
});

test('failed and stale assessments preserve last success while reporting current health Unknown', async () => {
  const successful = { assessmentId: 'a', assessedAt: new Date(now - STALE_AFTER_MS - 1), inventoryRevision: inventoryRevision(), versionHealth: 'Healthy',
    configuredVersion: '1.64', endpoints: API_HEALTH_INVENTORY.map(endpoint => ({ ...endpoint, versionHealth: 'Healthy' })), counts: { Healthy: 6 } };
  let state = { latestSuccessful: successful, lastAttemptStatus: 'failed', lastAttemptAt: new Date(now), lastFailure: { errorCode: 'API_READ_FAILED' }, history: [successful] };
  const service = createApiHealthService({ baseUrl: 'https://tenant.example', configuredVersion: '1.64', store: { async getApiHealthState() { return state; },
    async acquireApiHealthLease() { return { token: 'lease' }; }, async saveApiHealthResult(_token, _mode, result) { state.lastAttemptStatus = result.status; } },
    now: () => now, oauth: { async getAccessToken() { return 'token'; } }, async get() { throw Object.assign(new Error('sensitive'), { code: 'API_READ_FAILED', response: { status: 503 } }); },
    async http() { throw new Error('unused'); }, logger: { warn() {} } });
  const before = await service.getCached();
  assert.equal(before.currentStatus, 'Unknown'); assert.equal(before.stale, true); assert.equal(before.latestSuccessful, successful);
  const run = await service.runManual();
  assert.equal(run.status, 'failed'); assert.equal(run.failure.errorCode, 'API_READ_FAILED'); assert.equal(JSON.stringify(run).includes('sensitive'), false);
});

test('Mongo coordination applies manual cooldown, concurrent lease protection, bounded history, and tenant scoping', async () => {
  const docs = new Map();
  const collection = {
    async createIndex() {},
    async findOneAndUpdate(filter, update) {
      const current=docs.get(filter._id);
      const predicates=filter.$and||[];
      const matches=predicates.every(predicate=>{
        const clause=predicate.$or||[];
        return clause.some(item=>{const [key,condition]=Object.entries(item)[0],value=current?.[key];
          return condition.$exists===false?!Object.hasOwn(current||{},key):value instanceof Date&&value<=condition.$lte;});
      });
      if(current&&!matches)return{value:null};
      const next={...(current||{}),...update.$set};docs.set(filter._id,next);return{value:next};
    },
    async findOne(filter) { const value=docs.get(filter._id);return value?{...value}:null; },
    async updateOne(filter, update) {
      const current=docs.get(filter._id);if(!current||current.leaseToken!==filter.leaseToken)return{matchedCount:0};
      const next={...current,...update.$set};for(const key of Object.keys(update.$unset||{}))delete next[key];
      if(update.$push?.history){const items=update.$push.history.$each;next.history=[...(next.history||[]),...items].slice(update.$push.history.$slice)}
      docs.set(filter._id,next);return{matchedCount:1};
    }
  };
  const mongoClient={db(){return{collection(){return collection}}},async close(){}};
  const a=createSectionAssociationStore({uri:'mongodb://unused',namespace:'tenant-a',mongoClient,now:()=>now});
  const b=createSectionAssociationStore({uri:'mongodb://unused',namespace:'tenant-b',mongoClient,now:()=>now});
  const first=await a.acquireApiHealthLease('manual',300000,300000,now);assert.equal(first.token.length>0,true);
  assert.equal((await a.acquireApiHealthLease('automatic',300000,300000,now)).reason,'busy');
  const assessment={assessmentId:'one',assessedAt:new Date(now),inventoryRevision:inventoryRevision(),versionHealth:'Healthy',endpoints:[],counts:{}};
  await a.saveApiHealthResult(first.token,'manual',{status:'success',attemptedAt:new Date(now),assessment});
  assert.equal((await a.acquireApiHealthLease('manual',300000,300000,now+1000)).reason,'cooldown');
  assert.equal((await b.getApiHealthState()),null);
  const auto=await b.acquireApiHealthLease('automatic',300000,300000,now+1000);assert.ok(auto.token);
  await b.saveApiHealthResult(auto.token,'automatic',{status:'success',attemptedAt:new Date(now+1000),assessment:{...assessment,assessmentId:'two'}});
  assert.equal((await a.getApiHealthState()).latestSuccessful.assessmentId,'one');
  assert.equal((await b.getApiHealthState()).latestSuccessful.assessmentId,'two');
});

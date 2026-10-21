'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ASSOCIATION_CODE, isAssociation, originalOfferingCode } = require('../src/sectionAssociations/rules');
const { resolveTargets } = require('../src/sectionAssociations/resolver');
const { createReconciler, courseUpdatePayload, hasVerifiedCompletion, RECONCILIATION_VERSION } = require('../src/sectionAssociations/reconciler');
const { createSectionAssociationClient } = require('../src/sectionAssociations/client');
const { createSectionAssociationService } = require('../src/sectionAssociations/service');
const { createBrightspaceGet } = require('../src/shared/client');
const { logEvent } = require('../src/sectionAssociations/log');

const association = { Identifier: 33664, Code: '002521-01-2602-I0001', Type: { Code: 'Course Offering' } };
const courseRecord = (overrides = {}) => ({ Name: 'Original', Code: '002521-01-2602-GS2-EL1S', StartDate: null, EndDate: null,
  LocaleId: 0, ForceLocale: false, ShowAddressBook: true, IsActive: true,
  Description: { Text: 'Plain description', Html: '<p>Rich description</p>' }, CanSelfRegister: false, ...overrides });
const groups = [
  { Identifier: 33669, Code: '002521-01-2602-GS2-EL1S-03229', Type: { Code: 'Group' } },
  { Identifier: 33673, Code: '002521-01-2602-GS2-EL1T-03230', Type: { Code: 'Group' } }
];
function api(overrides = {}) {
  const writes = [];
  const records = new Map([['100', courseRecord()], ['101', courseRecord({ Code: '002521-01-2602-GS2-EL1T', IsActive: false })]]);
  const client = {
    async orgUnit() { return association; }, async children() { return groups; },
    async exactCode(code) { return [{ Identifier: code.endsWith('EL1S') ? 100 : 101, Code: code, Type: { Code: 'Course Offering' } }]; },
    async course(id) { return { ...records.get(String(id)) }; },
    async putCourse(id, body) { writes.push({ id: String(id), body }); records.set(String(id), { ...records.get(String(id)), IsActive: body.IsActive }); },
    ...overrides
  };
  return { client, writes, records };
}
function memoryStore(now = () => Date.now()) {
  const records = new Map();
  return { records, async get(id) { return records.get(String(id)) || null; }, async record(id, data) {
    const prior = records.get(String(id));
    records.set(String(id), { ...prior, ...data, associationOrgUnitId: String(id),
      firstSeenAt: prior?.firstSeenAt || new Date(now()), lastSeenAt: new Date(now()) });
  } };
}
function serviceMemoryStore(now = () => Date.now()) {
  const records = new Map();
  const store = {
    records,
    async baselineStatus() { return { state: 'ready' }; },
    async recordDiscovery(id, code) {
      const key = String(id);
      const prior = records.get(key);
      records.set(key, { ...prior, namespace: 'tenant', associationOrgUnitId: key, associationCode: code,
        firstSeenAt: prior?.firstSeenAt || new Date(now()), lastSeenAt: new Date(now()),
        status: prior?.status || 'pending', baseline: prior?.baseline || false });
      return !prior;
    },
    async recordDiscoveries(rows) {
      let newlyRecorded = 0;
      let alreadyKnown = 0;
      for (const row of rows) {
        if (await this.recordDiscovery(row.id, row.code)) newlyRecorded++;
        else alreadyKnown++;
      }
      return { newlyRecorded, alreadyKnown };
    },
    async listWaitingNew({ stabilityCutoff }) {
      return [...records.values()].filter(item => item.baseline !== true && item.status === 'pending' &&
        !item.lastCheckedAt && item.firstSeenAt > stabilityCutoff);
    },
    async listFastWork({ limit, stabilityCutoff }) {
      const rows = [...records.values()].filter(item => item.status === 'pending' &&
        (item.baseline === true || item.lastCheckedAt || item.firstSeenAt <= stabilityCutoff));
      return rows.slice(0, limit);
    },
    async listRecoveryWork({ limit, blockedBefore, reverifyBefore, stabilityCutoff }) {
      const rows = [...records.values()].filter(item => item.status === 'pending' ||
        (item.status === 'blocked' && (!item.lastCheckedAt || item.lastCheckedAt <= blockedBefore)) ||
        (item.status === 'completed' && item.reconciliationVersion === 1 && item.lastVerifiedAt <= reverifyBefore) ||
        (item.baseline === true && (!item.lastVerifiedAt || item.reconciliationVersion !== 1)) ||
        (item.baseline !== true && item.status === 'pending' && item.firstSeenAt <= stabilityCutoff));
      return rows.slice(0, limit);
    },
    async countHistoricalBacklog() { return [...records.values()].filter(item => item.baseline === true && (!item.lastVerifiedAt || item.reconciliationVersion !== 1)).length; },
    async countDueCompleted() { return 0; },
    async countRecoveryWork() { return 0; },
    async record(id, fields) {
      const key = String(id);
      records.set(key, { ...records.get(key), ...fields, associationOrgUnitId: key,
        lastCheckedAt: new Date(now()), firstSeenAt: records.get(key)?.firstSeenAt || new Date(now()) });
    }
  };
  return store;
}
function captureLogger() {
  const lines = [];
  return { lines, info(message) { lines.push(message); }, warn(message) { lines.push(message); }, error(message) { lines.push(message); } };
}

test('association code and child suffix validation are exact', () => {
  assert.match('002521-01-2602-I0001', ASSOCIATION_CODE);
  assert.equal(isAssociation(association), true);
  assert.equal(isAssociation({ ...association, Code: 'x002521-01-2602-I0001' }), false);
  assert.equal(originalOfferingCode(groups[0].Code), '002521-01-2602-GS2-EL1S');
  assert.throws(() => originalOfferingCode('002521-01-2602-GS2-EL1S-3229'), /exactly five digits/);
});

test('association type and exact code are both required before any association work', async () => {
  for (const orgUnit of [
    { ...association, Type: { Code: 'Group' } },
    { ...association, Code: '002521-01-2602-extra-I0001' }
  ]) {
    const { client, writes } = api({ orgUnit: async () => orgUnit });
    const result = await createReconciler({ client, store: memoryStore(), dryRun: false }).reconcileAssociation('33664');
    assert.equal(result.status, 'blocked');
    assert.equal(writes.length, 0);
  }
});

test('zero children, malformed one child, duplicate and ambiguous targets block safely', async () => {
  for (const override of [
    { children: async () => [] },
    { children: async () => [{ ...groups[0], Type: { Code: 'Course Offering' } }] },
    { children: async () => [groups[0], { ...groups[1], Code: groups[0].Code }] },
    { exactCode: async () => [{ Identifier: 100, Type: { Code: 'Course Offering' } }, { Identifier: 102, Type: { Code: 'Course Offering' } }] }
  ]) {
    const { client, writes } = api(override);
    const result = await createReconciler({ client, store: memoryStore(), dryRun: false }).reconcileAssociation('33664');
    assert.equal(result.status, 'blocked');
    assert.equal(writes.length, 0);
  }
  const zero = api({ children: async () => [] });
  const zeroResult = await createReconciler({ client: zero.client, store: memoryStore(), dryRun: false }).reconcileAssociation('33664');
  assert.equal(zeroResult.status, 'blocked');
  assert.match(zeroResult.error, /at least one direct child/);
  await assert.rejects(resolveTargets({ association, client: api({ exactCode: async () => [{ Identifier: 100, Type: { Code: 'Group' } }] }).client }), /not a valid Course Offering/);
});

test('one valid child resolves exactly one target for dry-run and apply', async () => {
  const singleChild = [groups[0]];
  const dry = api({ children: async () => singleChild });
  const dryResult = await createReconciler({ client: dry.client, store: memoryStore(), dryRun: true }).reconcileAssociation('33664');
  assert.equal(dryResult.status, 'pending');
  assert.deepEqual(dryResult.targets.map(target => target.status), ['would-inactivate']);
  assert.equal(dry.writes.length, 0);

  const live = api({ children: async () => singleChild });
  const liveResult = await createReconciler({ client: live.client, store: memoryStore(), dryRun: false }).reconcileAssociation('33664');
  assert.equal(liveResult.status, 'completed');
  assert.deepEqual(liveResult.targets.map(target => target.code), ['002521-01-2602-GS2-EL1S']);
  assert.equal(live.writes.length, 1);
  assert.equal(live.writes[0].id, '100');
});

test('all target records are validated before mutation, preventing partial writes', async () => {
  const { client, writes } = api({ course: async id => id === '100' ? courseRecord() : ({ IsActive: true }) });
  const result = await createReconciler({ client, store: memoryStore(), dryRun: false }).reconcileAssociation('33664');
  assert.equal(result.status, 'blocked');
  assert.equal(writes.length, 0);
});

test('full update payload preserves current course fields and converts RichText', () => {
  assert.deepEqual(courseUpdatePayload(courseRecord()), {
    Name: 'Original', Code: '002521-01-2602-GS2-EL1S', StartDate: null, EndDate: null,
    LocaleId: 0, ForceLocale: false, ShowAddressBook: true, IsActive: false,
    Description: { Content: '<p>Rich description</p>', Type: 'Html' }, CanSelfRegister: false
  });
  assert.deepEqual(courseUpdatePayload(courseRecord({ Description: { Text: 'Text', Html: '' } })).Description, { Content: 'Text', Type: 'Text' });
  assert.throws(() => courseUpdatePayload({ ...courseRecord(), Description: null }), /unsupported format/);
});

test('inactive offerings are left alone; active offerings use GET/PUT/GET verification', async () => {
  const { client, writes } = api();
  const result = await createReconciler({ client, store: memoryStore(), dryRun: false }).reconcileAssociation('33664');
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.targets.map(target => target.status), ['verified-inactive', 'already-inactive']);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].body.IsActive, false);
});

test('only verified active target changes create execution-scoped correction audit rows', async () => {
  const { client } = api(); const audit = [];
  const execution = { executionId: 'exec-1', source: 'manual' };
  const result = await createReconciler({ client, store: memoryStore(), dryRun: false, now: () => 1234 })
    .reconcileAssociation('33664', { execution, recordAudit: async record => audit.push(record) });
  assert.equal(result.writesVerified, 1);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].executionId, 'exec-1'); assert.equal(audit[0].source, 'manual');
  assert.equal(audit[0].parentAssociationD2lId, '33664');
  assert.equal(audit[0].affectedCourseOfferingD2lId, '100');
  assert.equal(audit[0].previousIsActive, true); assert.equal(audit[0].verifiedIsActive, false);
  assert.equal(audit[0].result, 'Successfully updated');
});

test('failed verification creates an exception and no successful correction record', async () => {
  const { client } = api({ async putCourse() {} }); const audit = [];
  const result = await createReconciler({ client, store: memoryStore(), dryRun: false })
    .reconcileAssociation('33664', { execution: { executionId: 'exec-2', source: 'automatic' },
      recordAudit: async record => audit.push(record) });
  assert.equal(result.status, 'pending');
  assert.equal(audit.some(record => record.kind === 'correction'), false);
  assert.equal(audit[0].kind, 'exception'); assert.equal(audit[0].category, 'verification-failed');
});

test('read failures retain their stage, HTTP status, and available association/target context without writes', async () => {
  const cases = [
    { label: 'association detail', override: { async orgUnit() { throw apiRead(404); } }, stage: 'association-read', endpoint: null, status: 404 },
    { label: 'Group children', override: { async orgUnit() { return { ...association, Name: 'Association Name' }; }, async children() { throw apiRead(404, 'orgstructure-children'); } }, stage: 'children-read', endpoint: 'direct Group children', status: 404 },
    { label: 'exact code lookup', override: { async orgUnit() { return { ...association, Name: 'Association Name' }; }, async exactCode() { throw apiRead(503, 'exact-org-code'); } }, stage: 'exact-code-lookup', endpoint: 'exact Org Code', status: 503 },
    { label: 'target offering', override: { async orgUnit() { return { ...association, Name: 'Association Name' }; }, async children() { return [groups[0]]; }, async exactCode(code) { return [{ Identifier: 100, Code: code, Name: 'Original Name', Type: { Code: 'Course Offering' } }]; }, async course() { throw apiRead(404, 'course-offering'); } }, stage: 'target-read', endpoint: 'original Course Offering', status: 404 }
  ];
  for (const item of cases) {
    const { client, writes } = api(item.override); const audit = []; const logger = captureLogger();
    const result = await createReconciler({ client, store: memoryStore(), dryRun: false, logger })
      .reconcileAssociation('33664', { execution: { executionId: `failure-${item.stage}`, source: 'manual' }, recordAudit: async row => audit.push(row) });
    assert.equal(result.status, 'pending', item.label); assert.equal(writes.length, 0, item.label);
    assert.equal(audit[0].category, 'read-failed', item.label);
    assert.match(audit[0].explanation, new RegExp(item.endpoint || 'association Course Offering'));
    assert.match(audit[0].explanation, new RegExp(`HTTP ${item.status}`));
    assert.ok(logger.lines.some(line => line.includes(`stage=${item.stage}`) && line.includes(`httpStatus=${item.status}`)), item.label);
    assert.equal(audit[0].parentAssociationName, item.stage === 'association-read' ? '' : 'Association Name');
    if (item.stage === 'exact-code-lookup') assert.match(audit[0].explanation, /002521-01-2602-GS2-EL1S/);
    if (item.stage === 'target-read') {
      assert.equal(audit[0].affectedCourseOfferingD2lId, '100');
      assert.equal(audit[0].affectedCourseOfferingName, 'Original Name');
    }
  }
});

test('initial association-detail 404 records one pending missing observation and one exception', async () => {
  const store = memoryStore(() => Date.parse('2026-10-20T12:00:00Z'));
  await store.record('48865', { associationCode: '002366-01-2602-I0001', status: 'pending' });
  store.recordPotentialMissing = async (id, observedAt) => {
    const prior = await store.get(id);
    if (prior.missingObservedAt) return false;
    await store.record(id, { missingObservedAt: observedAt });
    return true;
  };
  const { client, writes } = api({ async orgUnit() { throw apiRead(404, 'association-detail'); } });
  const audit = [];
  const reconciler = createReconciler({ client, store, dryRun: false, now: () => Date.parse('2026-10-20T12:00:00Z'), logger: { warn() {}, info() {} } });
  const first = await reconciler.reconcileAssociation('48865', { associationCode: '002366-01-2602-I0001',
    execution: { executionId: '404-first', source: 'automatic' }, recordAudit: async row => audit.push(row) });
  const second = await reconciler.reconcileAssociation('48865', { associationCode: '002366-01-2602-I0001',
    execution: { executionId: '404-repeat', source: 'automatic' }, recordAudit: async row => audit.push(row) });
  assert.equal(first.status, 'pending'); assert.equal(second.status, 'pending');
  assert.equal((await store.get('48865')).missingObservedAt.getTime(), Date.parse('2026-10-20T12:00:00Z'));
  assert.equal(audit.filter(row => row.category === 'read-failed').length, 1);
  assert.equal(writes.length, 0);
});

test('network, timeout, and OAuth errors have safe explanations without invented HTTP status', async () => {
  for (const [reason, phrase, code] of [['api-network-failed', 'network error', 'ECONNRESET'], ['api-timeout', 'network timeout', 'ETIMEDOUT'], ['oauth-failed', 'OAuth token request failed', 'TOKEN_EXCHANGE_FAILED']]) {
    const { client } = api({ async orgUnit() { throw Object.assign(new Error('secret=abc https://private.example/path'), { code, reason, ...(reason === 'oauth-failed' ? {} : { status: null }) }); } });
    const audit = [];
    const result = await createReconciler({ client, store: memoryStore(), dryRun: false })
      .reconcileAssociation('33664', { execution: { executionId: `network-${code}`, source: 'manual' }, recordAudit: async row => audit.push(row) });
    assert.equal(result.status, 'pending'); assert.equal(audit[0].category, 'read-failed');
    assert.match(audit[0].explanation, new RegExp(phrase)); assert.doesNotMatch(audit[0].explanation, /HTTP \d|abc|private\.example/);
  }
});

test('Brightspace read wrapper retains only safe HTTP or known network diagnostics', async () => {
  const httpError = Object.assign(new Error('private response body token=secret'), { response: { status: 404, data: 'private' }, config: { url: 'https://tenant.example/private?token=secret' } });
  const client = createSectionAssociationClient({ baseUrl: 'https://tenant.example', lpVersion: '1.60', oauth: {}, http: async () => {}, get: async () => { throw httpError; } });
  await assert.rejects(client.children('33664'), error => {
    assert.equal(error.status, 404); assert.equal(error.endpoint, 'orgstructure-children'); assert.equal(error.reason, 'api-read-failed');
    assert.equal(error.cause, httpError); assert.doesNotMatch(error.message, /private|secret|tenant/); return true;
  });
  const networkClient = createSectionAssociationClient({ baseUrl: 'https://tenant.example', lpVersion: '1.60', oauth: {}, http: async () => {},
    get: async () => { throw Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }); } });
  await assert.rejects(networkClient.orgUnit('33664'), error => {
    assert.equal(error.status, null); assert.equal(error.reason, 'api-network-failed'); return true;
  });
});

test('PUT and verification GET failures retain distinct exception categories', async () => {
  const putFailure = api({ async putCourse() { throw Object.assign(new Error('Course Offering update failed.'), { status: 503, reason: 'api-update-failed' }); } });
  const putAudit = [];
  const putResult = await createReconciler({ client: putFailure.client, store: memoryStore(), dryRun: false })
    .reconcileAssociation('33664', { execution: { executionId: 'put-failed', source: 'manual' }, recordAudit: async row => putAudit.push(row) });
  assert.equal(putResult.status, 'pending'); assert.equal(putFailure.writes.length, 0);
  assert.equal(putAudit[0].category, 'update-failed'); assert.match(putAudit[0].explanation, /HTTP 503/);

  const verifyFailure = api({ async course(id) { if (this.reads++ >= 3) throw apiRead(502, 'course-offering'); return { ...courseRecord(), IsActive: true }; }, reads: 0 });
  const verifyAudit = [];
  const verifyResult = await createReconciler({ client: verifyFailure.client, store: memoryStore(), dryRun: false })
    .reconcileAssociation('33664', { execution: { executionId: 'verify-failed', source: 'manual' }, recordAudit: async row => verifyAudit.push(row) });
  assert.equal(verifyResult.status, 'pending'); assert.equal(verifyFailure.writes.length, 1);
  assert.equal(verifyAudit[0].category, 'verification-failed'); assert.match(verifyAudit[0].explanation, /HTTP 502/);
});

function apiRead(status, endpoint) { return Object.assign(new Error('Brightspace API read failed'), { code: 'API_READ_FAILED', status, endpoint, reason: 'api-read-failed' }); }

test('all-inactive dry-run records positive verification evidence and completed records are skipped until due', async () => {
  const inactive = api({ course: async () => courseRecord({ IsActive: false }) });
  const store = memoryStore(() => 123456);
  const completed = await createReconciler({ client: inactive.client, store, dryRun: true, now: () => 123456 })
    .reconcileAssociation('33664', { associationCode: association.Code });
  assert.equal(completed.status, 'completed');
  assert.equal(inactive.writes.length, 0);
  const evidence = await store.get('33664');
  assert.equal(evidence.reconciliationVersion, RECONCILIATION_VERSION);
  assert.ok(evidence.lastReconciledAt instanceof Date);
  assert.ok(evidence.lastVerifiedAt instanceof Date);
  assert.equal(hasVerifiedCompletion(evidence), true);

  let reads = 0;
  const skipped = await createReconciler({ client: { async orgUnit() { reads++; } }, store, dryRun: false })
    .reconcileAssociation('33664');
  assert.deepEqual(skipped, { status: 'completed', skipped: true });
  assert.equal(reads, 0);
});

test('reverification uses the normal resolver and re-inactivates a target that became active', async () => {
  const { client, writes } = api();
  const store = memoryStore();
  await store.record('33664', { associationCode: association.Code, status: 'completed', baseline: true,
    reconciliationVersion: RECONCILIATION_VERSION, lastReconciledAt: new Date(1), lastVerifiedAt: new Date(1) });
  const result = await createReconciler({ client, store, dryRun: false }).reconcileAssociation('33664', { force: true });
  assert.equal(result.status, 'completed');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].id, '100');
  assert.equal((await store.get('33664')).baseline, true);
});

test('post-PUT state must verify inactive', async () => {
  let reads = 0;
  const { client, writes } = api({ course: async () => { reads++; return courseRecord({ IsActive: true }); } });
  const result = await createReconciler({ client, store: memoryStore(), dryRun: false }).reconcileAssociation('33664');
  assert.equal(result.status, 'pending');
  assert.equal(writes.length, 1);
  assert.equal(reads, 4);
});

test('dry-run goes through resolution and validation but performs zero PUTs and stays pending', async () => {
  const { client, writes } = api();
  const store = memoryStore();
  const logger = captureLogger();
  const result = await createReconciler({ client, store, dryRun: true, logger }).reconcileAssociation('33664', { associationCode: association.Code });
  assert.equal(result.status, 'pending');
  assert.equal(result.dryRun, true);
  assert.deepEqual(result.targets.map(target => target.status), ['would-inactivate', 'already-inactive']);
  assert.equal(writes.length, 0);
  assert.ok(logger.lines.includes('[section-association] dry-run associationId=33664 targetId=100 code=002521-01-2602-GS2-EL1S action=would-inactivate'));
  assert.ok(logger.lines.includes('[section-association] dry-run associationId=33664 targetId=101 code=002521-01-2602-GS2-EL1T action=already-inactive'));
  assert.ok(logger.lines.includes('[section-association] validation passed associationId=33664 children=2 targets=2'));
});

test('blocked validation logs a safe reason without child code or API response content', async () => {
  const logger = captureLogger();
  const { client } = api({ children: async () => [
    { Identifier: 1, Code: 'TOPSECRET-RESPONSE-BODY', Type: { Code: 'Group' } }, groups[1]
  ] });
  const result = await createReconciler({ client, store: memoryStore(), dryRun: true, logger }).reconcileAssociation('33664', { associationCode: association.Code });
  assert.equal(result.status, 'blocked');
  assert.ok(logger.lines.some(line => line === '[section-association] blocked associationId=33664 code=002521-01-2602-I0001 reason=invalid-child-code'));
  assert.equal(logger.lines.some(line => line.includes('TOPSECRET-RESPONSE-BODY')), false);
});

test('live verified updates emit start and success events', async () => {
  const logger = captureLogger();
  const { client, writes } = api();
  const result = await createReconciler({ client, store: memoryStore(), dryRun: false, logger }).reconcileAssociation('33664', { associationCode: association.Code });
  assert.equal(result.status, 'completed');
  assert.equal(writes.length, 1);
  assert.ok(logger.lines.includes('[section-association] update starting associationId=33664 targetId=100 code=002521-01-2602-GS2-EL1S'));
  assert.ok(logger.lines.includes('[section-association] update verified associationId=33664 targetId=100 isActive=false'));
  assert.ok(logger.lines.includes('[section-association] target already compliant associationId=33664 targetId=101'));
});

test('structured logger excludes unapproved fields and redacts non-course codes', () => {
  const logger = captureLogger();
  logEvent(logger, 'info', 'dry-run', {
    associationId: '33664', targetId: '100', code: 'TOPSECRET', action: 'would-inactivate',
    token: 'oauth-secret', privateKey: 'private-key', payload: { IsActive: false }, authorization: 'Bearer secret'
  });
  assert.deepEqual(logger.lines, ['[section-association] dry-run associationId=33664 targetId=100 code=[redacted] action=would-inactivate']);
});

test('uncertain PUT is read back and never replayed', async () => {
  let reads = 0;
  const { client, writes, records } = api({ course: async id => {
    reads++;
    if (reads === 4) records.set(String(id), { ...courseRecord(), IsActive: false });
    return { ...records.get(String(id)) };
  }, putCourse: async () => { writes.push('attempt'); const error = new Error('lost response'); error.uncertain = true; throw error; } });
  const result = await createReconciler({ client, store: memoryStore(), dryRun: false }).reconcileAssociation('33664');
  assert.equal(result.status, 'completed');
  assert.equal(writes.length, 1);
});

test('discovery follows every bookmark and filters exact association codes', async () => {
  const requested = [];
  const client = createSectionAssociationClient({ baseUrl: 'https://tenant.example', lpVersion: '1.60', oauth: {}, http: async () => {}, get: async url => {
    requested.push(url);
    if (requested.length === 1) return { Items: [{ Code: '001111-01-2601-I0001' }], PagingInfo: { HasMoreItems: true, Bookmark: 'next-page' } };
    return { Items: [{ Code: '002521-01-2602-I0001' }], PagingInfo: { HasMoreItems: false, Bookmark: null } };
  } });
  const found = await client.associationCandidates();
  assert.equal(new URL(requested[0]).pathname, '/d2l/api/lp/1.60/orgstructure/');
  assert.equal(new URL(requested[0]).search, '?orgUnitType=3&orgUnitCode=I0001');
  assert.equal(new URL(requested[1]).search, '?orgUnitType=3&orgUnitCode=I0001&bookmark=next-page');
  assert.equal(found.length, 2);
  const service = createSectionAssociationService({ client: { async associationCandidates() { return [
    association, association, { ...association, Code: 'prefix-002521-01-2602-I0001' }, { ...association, Type: { Code: 'Group' } }
  ]; } }, store: {}, reconciler: {}, logger: { error() {} } });
  assert.deepEqual((await service.discover()).map(item => item.Code), [association.Code]);
});

test('discovery HTTP 401 and 403 failures log safe typed status and do not log success counters', async () => {
  for (const status of [401, 403]) {
    const logger = captureLogger();
    const client = createSectionAssociationClient({ baseUrl: 'https://tenant.example', lpVersion: '1.60', oauth: {}, http: async () => {},
      get: async () => { throw { response: { status, data: { detail: 'sensitive body' } }, config: { headers: { Authorization: 'secret' } } }; } });
    const service = createSectionAssociationService({ client, store: {}, reconciler: {}, logger, now: () => 5520 });
    await service.fastTick();
    assert.ok(logger.lines.some(line => new RegExp(`^\\[section-association\\] fast cycle failed phase=discovery elapsedMs=\\d+ endpoint=association-candidates code=API_READ_FAILED httpStatus=${status} fatal=true$`).test(line)));
    assert.ok(logger.lines.some(line => /^\[section-association\] fast cycle finished status=failed elapsedMs=\d+$/.test(line)));
    assert.equal(logger.lines.some(line => line.startsWith('[section-association] fast cycle completed')), false);
    assert.equal(logger.lines.join('\n').includes('sensitive body'), false);
    assert.equal(logger.lines.join('\n').includes('Authorization'), false);
  }
});

test('OAuth token failures log safe protocol classification separately from API reads', async () => {
  const logger = captureLogger();
  const get = createBrightspaceGet({ baseUrl: 'https://tenant.example', http: async () => {}, oauth: { async getAccessToken() {
    const error = new Error('secret assertion and response');
    Object.assign(error, { code: 'TOKEN_EXCHANGE_FAILED', status: 401, protocolCode: 'invalid_client' });
    throw error;
  } } });
  const client = createSectionAssociationClient({ get, baseUrl: 'https://tenant.example', lpVersion: '1.60', oauth: {}, http: async () => {} });
  const service = createSectionAssociationService({ client, store: {}, reconciler: {}, logger });
  await service.fastTick();
  assert.ok(logger.lines.some(line => /^\[section-association\] fast cycle failed phase=oauth elapsedMs=\d+ endpoint=oauth-token code=TOKEN_EXCHANGE_FAILED httpStatus=401 protocolCode=invalid_client fatal=true$/.test(line)));
  assert.equal(logger.lines.join('\n').includes('assertion'), false);
});

test('database failures report database phase without logging error messages or connection details', async () => {
  const logger = captureLogger();
  const error = new Error('mongodb://user:password@host/private-database');
  error.code = 'ETIMEDOUT';
  const service = createSectionAssociationService({ client: { async associationCandidates() { return []; } },
    store: { async baselineStatus() { throw error; } }, reconciler: {}, logger });
  await service.fastTick();
  assert.ok(logger.lines.some(line => /^\[section-association\] fast cycle failed phase=database elapsedMs=\d+ code=ETIMEDOUT$/.test(line)));
  assert.ok(logger.lines.some(line => /^\[section-association\] fast cycle finished status=failed elapsedMs=\d+$/.test(line)));
  assert.equal(logger.lines.join('\n').includes('mongodb://'), false);
  assert.equal(logger.lines.some(line => line.startsWith('[section-association] fast cycle completed')), false);
});

test('Mongo-backed API gate failures during discovery retain their database classification', async () => {
  const logger = captureLogger();
  const gateError = Object.assign(new Error('mongodb://user:secret@host/private'), { code: 50, phase: 'database' });
  const client = createSectionAssociationClient({ baseUrl: 'https://tenant.example', lpVersion: '1.60', oauth: {}, http: async () => {},
    get: async () => { throw gateError; } });
  const service = createSectionAssociationService({ client, store: {}, reconciler: {}, logger });
  await service.fastTick();
  assert.ok(logger.lines.some(line => /^\[section-association\] fast cycle failed phase=database elapsedMs=\d+ code=50$/.test(line)));
  assert.equal(logger.lines.join('\n').includes('mongodb://'), false);
});

test('partial discovery persistence failure fails the cycle without a discovery success summary', async () => {
  const logger = captureLogger();
  const service = createSectionAssociationService({
    client: { async associationCandidates() { return [association]; } },
    store: { async baselineStatus() { return { state: 'ready' }; }, async recordDiscoveries() { throw new Error('partial bulk write'); } },
    reconciler: {}, logger
  });
  const result = await service.fastTick();
  assert.equal(result.status, 'failed');
  assert.equal(logger.lines.some(line => line.startsWith('[section-association] discovery completed')), false);
  assert.equal(logger.lines.some(line => line.startsWith('[section-association] fast cycle completed')), false);
});

test('first successful discovery records baseline history and sends it through the shared reconciler', async () => {
  let ready = false;
  const events = [];
  const store = serviceMemoryStore(() => 10000000);
  store.baselineStatus = async () => ready ? { state: 'ready' } : null;
  store.beginBaseline = async () => 'token';
  store.finishBaseline = async (_token, rows) => {
    events.push('baseline-persisted');
    ready = true;
    store.rows = rows;
    for (const row of rows) store.records.set(String(row.id), { namespace: 'tenant', associationOrgUnitId: String(row.id),
      associationCode: row.code, baseline: true, status: 'pending', firstSeenAt: new Date(10000000) });
    return { newlyRecorded: rows.length, alreadyKnown: 0 };
  };
  const recordDiscoveries = store.recordDiscoveries.bind(store);
  store.recordDiscoveries = async rows => { events.push('incremental-persisted'); return recordDiscoveries(rows); };
  store.releaseBaseline = async () => {};
  let reconciles = 0;
  const service = createSectionAssociationService({ client: { async associationCandidates(code) {
    events.push(`query:${code}`); return [association];
  } }, store,
    reconciler: { async reconcileAssociation() { reconciles++; return { status: 'completed' }; } }, logger: { info() {} }, now: () => 10000000 });
  await service.fastTick();
  assert.equal(store.rows.length, 1);
  assert.deepEqual(events.slice(0, 2), ['query:I0001', 'baseline-persisted']);
  assert.match(events[2], /^query:\d{4}-I0001$/);
  assert.equal(reconciles, 1);
});

test('pending associations wait ten minutes and completed associations are skipped', async () => {
  let time = 100000000;
  const store = serviceMemoryStore(() => time);
  const seen = [];
  const logger = captureLogger();
  const service = createSectionAssociationService({ client: { async associationCandidates() { return [association]; } }, store,
    reconciler: { async reconcileAssociation(id) { seen.push(id); await store.record(id, { status: 'completed', reconciliationVersion: 1, lastReconciledAt: new Date(time), lastVerifiedAt: new Date(time) }); return { status: 'completed' }; } },
    stabilityMinutes: 10, now: () => time, logger });
  await service.fastTick();
  assert.equal(seen.length, 0);
  assert.equal(logger.lines.filter(line => line === '[section-association] pending associationId=33664 reason=stability-window').length, 1);
  assert.ok(logger.lines.includes('[section-association] discovery completed candidates=1 new=1 alreadyKnown=0'));
  time += 10 * 60000;
  await service.fastTick();
  assert.deepEqual(seen, ['33664']);
  assert.equal(logger.lines.filter(line => line === '[section-association] pending associationId=33664 reason=stability-window').length, 1);
  assert.ok(logger.lines.some(line => line.startsWith('[section-association] fast cycle completed') && line.includes('completed=1')), logger.lines.join('\n'));
  await service.fastTick();
  assert.equal(seen.length, 1);
  assert.equal(logger.lines.filter(line => line === '[section-association] fast cycle started').length, 3);
  assert.equal(logger.lines.filter(line => line.startsWith('[section-association] fast cycle completed')).length, 3);
});

test('recovery cycle logs discovery and outcome counters', async () => {
  const time = 100000000;
  const store = serviceMemoryStore(() => time);
  await store.recordDiscovery('33664', association.Code);
  store.records.get('33664').lastCheckedAt = new Date(time - 10 * 60000);
  const logger = captureLogger();
  const service = createSectionAssociationService({
    client: { async associationCandidates() { return [association]; } }, store,
    reconciler: { async reconcileAssociation(id) { await store.record(id, { status: 'completed', reconciliationVersion: 1, lastReconciledAt: new Date(time), lastVerifiedAt: new Date(time) }); return { status: 'completed' }; } },
    now: () => time, logger
  });
  await service.recoveryTick();
  assert.ok(logger.lines.includes('[section-association] recovery cycle started'));
  assert.ok(logger.lines.includes('[section-association] discovery completed candidates=1 new=0 alreadyKnown=1'));
  assert.ok(logger.lines.some(line => line.startsWith('[section-association] recovery cycle completed') && line.includes('completed=1')), logger.lines.join('\n'));
});

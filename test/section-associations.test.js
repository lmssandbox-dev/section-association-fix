'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ASSOCIATION_CODE, isAssociation, originalOfferingCode } = require('../src/sectionAssociations/rules');
const { resolveTargets } = require('../src/sectionAssociations/resolver');
const { createReconciler, courseUpdatePayload } = require('../src/sectionAssociations/reconciler');
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

test('zero/one child, wrong child type, duplicate and ambiguous matches all fail before any write', async () => {
  for (const override of [
    { children: async () => [] },
    { children: async () => [groups[0]] },
    { children: async () => [{ ...groups[0], Type: { Code: 'Course Offering' } }, groups[1]] },
    { children: async () => [groups[0], { ...groups[1], Code: groups[0].Code }] },
    { exactCode: async () => [{ Identifier: 100, Type: { Code: 'Course Offering' } }, { Identifier: 102, Type: { Code: 'Course Offering' } }] }
  ]) {
    const { client, writes } = api(override);
    const result = await createReconciler({ client, store: memoryStore(), dryRun: false }).reconcileAssociation('33664');
    assert.notEqual(result.status, 'completed');
    assert.equal(writes.length, 0);
  }
  await assert.rejects(resolveTargets({ association, client: api({ exactCode: async () => [{ Identifier: 100, Type: { Code: 'Group' } }] }).client }), /not a valid Course Offering/);
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
  assert.equal(result.status, 'pending');
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
    association, { ...association, Code: 'prefix-002521-01-2602-I0001' }, { ...association, Type: { Code: 'Group' } }
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

test('first successful discovery baselines historical records without reconciliation', async () => {
  let ready = false;
  const store = { async baselineStatus() { return ready ? { state: 'ready' } : null; }, async beginBaseline() { return 'token'; }, async finishBaseline(_token, rows) { ready = true; this.rows = rows; }, async releaseBaseline() {} };
  let reconciles = 0;
  const service = createSectionAssociationService({ client: { async associationCandidates() { return [association]; } }, store,
    reconciler: { async reconcileAssociation() { reconciles++; } }, logger: { info() {} }, now: () => 10000000 });
  await service.fastTick();
  assert.equal(store.rows.length, 1);
  assert.equal(reconciles, 0);
});

test('pending associations wait ten minutes and completed associations are skipped', async () => {
  let time = 100000000;
  const store = memoryStore(() => time);
  store.baselineStatus = async () => ({ state: 'ready' });
  store.beginBaseline = async () => null;
  const seen = [];
  const logger = captureLogger();
  const service = createSectionAssociationService({ client: { async associationCandidates() { return [association]; } }, store,
    reconciler: { async reconcileAssociation(id) { seen.push(id); await store.record(id, { status: 'completed' }); return { status: 'completed' }; } },
    stabilityMinutes: 10, now: () => time, logger });
  await service.fastTick();
  assert.equal(seen.length, 0);
  assert.equal(logger.lines.filter(line => line === '[section-association] pending associationId=33664 reason=stability-window').length, 1);
  assert.ok(logger.lines.includes('[section-association] discovery completed candidates=1 new=1 alreadyKnown=0'));
  time += 10 * 60000;
  await service.fastTick();
  assert.deepEqual(seen, ['33664']);
  assert.equal(logger.lines.filter(line => line === '[section-association] pending associationId=33664 reason=stability-window').length, 1);
  assert.ok(logger.lines.includes('[section-association] fast cycle completed candidates=1 new=0 alreadyKnown=1 pending=0 completed=1 blocked=0'));
  await service.fastTick();
  assert.equal(seen.length, 1);
  assert.equal(logger.lines.filter(line => line === '[section-association] fast cycle started').length, 3);
  assert.equal(logger.lines.filter(line => line.startsWith('[section-association] fast cycle completed')).length, 3);
});

test('recovery cycle logs discovery and outcome counters', async () => {
  const time = 100000000;
  const store = memoryStore(() => time);
  store.baselineStatus = async () => ({ state: 'ready' });
  store.listUncompleted = async () => [...store.records.values()].filter(item => item.status !== 'completed');
  await store.record('33664', { associationCode: association.Code, status: 'pending' });
  store.records.get('33664').firstSeenAt = new Date(time - 10 * 60000);
  const logger = captureLogger();
  const service = createSectionAssociationService({
    client: { async associationCandidates() { return [association]; } }, store,
    reconciler: { async reconcileAssociation(id) { await store.record(id, { status: 'completed' }); return { status: 'completed' }; } },
    now: () => time, logger
  });
  await service.recoveryTick();
  assert.ok(logger.lines.includes('[section-association] recovery cycle started'));
  assert.ok(logger.lines.includes('[section-association] discovery completed candidates=1 new=0 alreadyKnown=1'));
  assert.ok(logger.lines.includes('[section-association] recovery cycle completed pending=0 blocked=0 completed=1'));
});

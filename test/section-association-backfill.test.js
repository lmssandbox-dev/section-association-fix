'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHistoricalBackfill, parseBackfillArgs, writeCsvReport, CSV_COLUMNS } = require('../src/sectionAssociations/backfill');
const { createSectionAssociationStore } = require('../src/sectionAssociations/store');

const association = { Identifier: 1, Code: '002521-01-2602-I0001', Type: { Code: 'Course Offering' } };
const targetCodes = ['002521-01-2602-GS2-EL1S', '002521-01-2602-GS2-EL2S'];

function targetCourse(id, code, active = true) {
  return { Identifier: id, Type: { Code: 'Course Offering' }, Name: `Offering ${id}`, Code: code,
    StartDate: null, EndDate: null, LocaleId: 1, ForceLocale: false, ShowAddressBook: true,
    IsActive: active, Description: { Text: 'Description' }, CanSelfRegister: false };
}

function setup({ active = [true, true], resolve = () => true, children = null, courseReads = {}, put = null } = {}) {
  const saved = { associationOrgUnitId: '1', associationCode: association.Code, baseline: true,
    status: 'completed', firstSeenAt: new Date(0) };
  const state = new Map([[10, targetCourse(10, targetCodes[0], active[0])], [11, targetCourse(11, targetCodes[1], active[1])]]);
  const reads = new Map();
  const puts = [];
  const updates = [];
  const records = [saved];
  const store = {
    async baselineStatus() { return { state: 'ready' }; },
    async listBaselineAssociations(limit) { this.limit = limit; return records.slice(0, limit); },
    async recordBackfill(id, fields) { updates.push({ id, fields }); Object.assign(saved, fields); return true; }
  };
  const client = {
    async orgUnit() { return association; },
    async children() { return children || targetCodes.map((code, index) => ({ Identifier: index + 3, Code: `${code}-0000${index + 1}`, Type: { Code: 'Group' } })); },
    async exactCode(code) {
      const index = targetCodes.indexOf(code);
      if (index < 0 || !resolve(code)) return [];
      return [{ Identifier: index + 10, Name: `Offering ${index + 10}`, Code: code, Type: { Code: 'Course Offering' } }];
    },
    async course(id) {
      const count = (reads.get(String(id)) || 0) + 1;
      reads.set(String(id), count);
      const override = courseReads[id]?.[count - 1];
      if (override instanceof Error) throw override;
      return structuredClone(override || state.get(Number(id)));
    },
    async putCourse(id, payload) {
      puts.push({ id: String(id), payload: structuredClone(payload) });
      if (put) return put({ id: String(id), payload, state, puts });
      state.get(Number(id)).IsActive = payload.IsActive;
    }
  };
  const logs = [];
  const workflow = createHistoricalBackfill({ client, store, now: () => 1000,
    logger: { info: line => logs.push(line), warn: line => logs.push(line), error: line => logs.push(line) } });
  return { workflow, client, store, saved, state, reads, puts, updates, logs, records };
}

test('backfill args default to dry-run and apply defaults to a batch of 50', () => {
  assert.deepEqual(parseBackfillArgs([]), { mode: 'dry-run', apply: false, maxAssociations: undefined });
  assert.deepEqual(parseBackfillArgs(['--apply']), { mode: 'apply', apply: true, maxAssociations: 50 });
  assert.deepEqual(parseBackfillArgs(['--dry-run', '--max-associations', '12']), { mode: 'dry-run', apply: false, maxAssociations: 12 });
  assert.throws(() => parseBackfillArgs(['--apply', '--dry-run']), /exactly one/);
  assert.throws(() => parseBackfillArgs(['--max-associations', '0']), /positive whole number/);
});

test('Mongo baseline query selects only historical baseline records in deterministic order', async () => {
  let filter, sorted, limited, writeFilter, writeUpdate;
  const cursor = { sort(value) { sorted = value; return this; }, limit(value) { limited = value; return this; }, async toArray() { return [{ baseline: true }]; } };
  const associations = { async createIndex() {}, find(value) { filter = value; return cursor; },
    async updateOne(f, u) { writeFilter = f; writeUpdate = u; return { matchedCount: 1 }; } };
  const mongoClient = { db: () => ({ collection(name) { return name === 'section_associations' ? associations : {}; } }) };
  const store = createSectionAssociationStore({ namespace: 'tenant', mongoClient });
  assert.deepEqual(await store.listBaselineAssociations(50), [{ baseline: true }]);
  assert.deepEqual(filter, { namespace: 'tenant', baseline: true });
  assert.deepEqual(sorted, { firstSeenAt: 1, associationOrgUnitId: 1 });
  assert.equal(limited, 50);
  assert.equal(await store.recordBackfill('1', { backfillStatus: 'completed', status: 'pending', baseline: false }), true);
  assert.deepEqual(writeFilter, { namespace: 'tenant', associationOrgUnitId: '1', baseline: true });
  assert.deepEqual(writeUpdate, { $set: { backfillStatus: 'completed' } });
});

test('dry-run classifies ready associations, reports targets, records metadata only, and never PUTs', async () => {
  const h = setup();
  const { rows, summary } = await h.workflow.run({ apply: false });
  assert.equal(h.store.limit, undefined);
  assert.equal(summary.ready, 1);
  assert.equal(summary.targetsFound, 2);
  assert.equal(summary.activeTargets, 2);
  assert.equal(summary.writesAttempted, 0);
  assert.equal(h.puts.length, 0);
  assert.deepEqual(rows.map(row => row.result), ['would-inactivate', 'would-inactivate']);
  assert.equal(h.saved.baseline, true);
  assert.equal(h.saved.status, 'completed');
  assert.equal(h.updates[0].fields.backfillStatus, 'ready');
  assert.equal(Object.hasOwn(h.updates[0].fields, 'status'), false);
});

test('already inactive targets classify the association as already-compliant and remain no-op', async () => {
  const h = setup({ active: [false, false] });
  const { rows, summary } = await h.workflow.run({ apply: true });
  assert.equal(summary.alreadyCompliant, 1);
  assert.equal(summary.alreadyInactiveTargets, 2);
  assert.equal(summary.writesAttempted, 0);
  assert.equal(h.puts.length, 0);
  assert.deepEqual(rows.map(row => row.result), ['already-inactive', 'already-inactive']);
  assert.equal(h.saved.backfillStatus, 'completed');
  assert.equal(h.saved.baseline, true);
});

test('invalid target resolution blocks the whole association before any PUT', async () => {
  const h = setup({ resolve: code => code !== targetCodes[1] });
  const { rows, summary } = await h.workflow.run({ apply: true });
  assert.equal(summary.blocked, 1);
  assert.equal(summary.writesAttempted, 0);
  assert.equal(h.puts.length, 0);
  assert.equal(rows[0].backfillClassification, 'blocked');
  assert.equal(rows[0].blockedReason, 'unresolved-target');
});

test('all target validation completes before the first write', async () => {
  const h = setup({ resolve: code => code !== targetCodes[1] });
  await h.workflow.run({ apply: true });
  assert.equal(h.reads.size, 0);
  assert.equal(h.puts.length, 0);
});

test('invalid current data on one target blocks all writes after validating the target set', async () => {
  const malformed = targetCourse(11, targetCodes[1], true);
  delete malformed.LocaleId;
  const h = setup({ courseReads: { 11: [malformed] } });
  const { rows, summary } = await h.workflow.run({ apply: true });
  assert.equal(summary.blocked, 1);
  assert.equal(summary.writesAttempted, 0);
  assert.equal(h.puts.length, 0);
  assert.equal(h.reads.get('10'), 1);
  assert.equal(h.reads.get('11'), 1);
  assert.equal(rows[0].blockedReason, 'invalid-course-offering');
});

test('apply re-reads each target immediately before writing and skips if it became inactive', async () => {
  const h = setup({ courseReads: { 10: [targetCourse(10, targetCodes[0], true), targetCourse(10, targetCodes[0], false)] } });
  const { rows, summary } = await h.workflow.run({ apply: true });
  assert.equal(h.reads.get('10'), 2);
  assert.equal(h.puts.some(put => put.id === '10'), false);
  assert.equal(rows[0].result, 'already-inactive');
  assert.equal(summary.writesAttempted, 1);
  assert.equal(summary.writesVerified, 1);
});

test('apply reuses full payload transformation and requires post-PUT verification', async () => {
  const h = setup();
  const { rows, summary } = await h.workflow.run({ apply: true });
  assert.equal(summary.writesAttempted, 2);
  assert.equal(summary.writesVerified, 2);
  assert.equal(h.puts[0].payload.IsActive, false);
  assert.deepEqual(h.puts[0].payload.Description, { Content: 'Description', Type: 'Text' });
  assert.equal(h.reads.get('10'), 3);
  assert.equal(rows[0].verifiedIsActive, false);
  assert.equal(rows[0].result, 'verified');
  assert.equal(h.saved.baseline, true);
  assert.equal(h.saved.status, 'completed');
  assert.equal(h.saved.backfillStatus, 'completed');
  const processedAt = h.saved.backfillProcessedAt;
  await h.workflow.run({ apply: false });
  assert.equal(h.saved.backfillProcessedAt, processedAt);
});

test('uncertain PUT outcome uses one read-back and does not blindly replay', async () => {
  let throws = true;
  const h = setup({ active: [true, false], put: ({ id, state }) => {
    state.get(Number(id)).IsActive = false;
    if (throws) { throws = false; throw Object.assign(new Error('transport'), { uncertain: true }); }
  } });
  const first = await h.workflow.run({ apply: true });
  assert.equal(first.summary.writesAttempted, 1);
  assert.equal(first.summary.writesVerified, 1);
  assert.equal(first.summary.writesFailed, 0);
  assert.equal(h.puts.length, 1);
  const second = await h.workflow.run({ apply: true });
  assert.equal(second.summary.writesAttempted, 0);
  assert.equal(h.puts.length, 1);
});

test('rerun resumes after a partial apply without rewriting targets already inactive', async () => {
  let rejectSecond = true;
  const h = setup({ put: ({ id, payload, state }) => {
    if (id === '11' && rejectSecond) throw Object.assign(new Error('rejected'), { code: 'HTTP_403' });
    state.get(Number(id)).IsActive = payload.IsActive;
  } });
  const first = await h.workflow.run({ apply: true });
  assert.equal(first.summary.writesAttempted, 2);
  assert.equal(first.summary.writesVerified, 1);
  assert.equal(first.summary.writesFailed, 1);
  rejectSecond = false;
  const second = await h.workflow.run({ apply: true });
  assert.equal(second.summary.writesAttempted, 1);
  assert.equal(second.summary.writesVerified, 1);
  assert.deepEqual(h.puts.map(write => write.id), ['10', '11', '11']);
});

test('association-level structural validation blocks every target before writing', async () => {
  const h = setup({ children: [{ Identifier: 2, Code: 'broken', Type: { Code: 'Group' } }] });
  const { rows, summary } = await h.workflow.run({ apply: true });
  assert.equal(summary.blocked, 1);
  assert.equal(summary.writesAttempted, 0);
  assert.equal(rows[0].blockedReason, 'insufficient-children');
});

test('CSV includes required columns and escapes dangerous values', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'section-association-backfill-'));
  try {
    const report = await writeCsvReport({ rows: [{ associationOrgUnitId: '1', targetCode: '=FORMULA', result: 'would-inactivate' }], outputDir: dir, now: () => 1, runId: 'test' });
    const text = await fs.readFile(report, 'utf8');
    assert.deepEqual(text.split('\r\n')[0].replace(/"/g, '').split(','), CSV_COLUMNS);
    assert.match(text, /'=FORMULA/);
    assert.match(text, /would-inactivate/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});


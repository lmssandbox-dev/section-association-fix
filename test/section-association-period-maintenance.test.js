'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSectionAssociationClient } = require('../src/sectionAssociations/client');
const { createSectionAssociationService, academicPeriods, isReverificationWindow, fullDiscoveryDue } = require('../src/sectionAssociations/service');

test('academic periods use Sao Paulo local date, semester convention, and year rollover', () => {
  assert.deepEqual(academicPeriods(Date.parse('2026-10-18T15:00:00Z')), { current: '2602', previous: '2601' });
  assert.deepEqual(academicPeriods(Date.parse('2027-01-01T02:30:00Z')), { current: '2602', previous: '2601' });
  assert.deepEqual(academicPeriods(Date.parse('2027-01-01T03:30:00Z')), { current: '2701', previous: '2602' });
  assert.deepEqual(academicPeriods(Date.parse('2026-06-30T23:30:00Z')), { current: '2601', previous: '2502' });
  assert.deepEqual(academicPeriods(Date.parse('2026-07-01T03:00:00Z')), { current: '2602', previous: '2601' });
});

test('maintenance window and full discovery due checks use Sao Paulo boundaries', () => {
  assert.equal(isReverificationWindow(Date.parse('2026-10-18T05:59:00Z')), false); // 02:59 local
  assert.equal(isReverificationWindow(Date.parse('2026-10-18T06:00:00Z')), true); // 03:00 local
  assert.equal(isReverificationWindow(Date.parse('2026-10-18T08:59:00Z')), true); // 05:59 local
  assert.equal(isReverificationWindow(Date.parse('2026-10-18T09:00:00Z')), false); // 06:00 local
  assert.equal(fullDiscoveryDue(new Date('2026-10-18T04:59:00Z'), Date.parse('2026-10-18T04:59:00Z')), false);
  assert.equal(fullDiscoveryDue(new Date('2026-10-18T04:59:00Z'), Date.parse('2026-10-18T05:00:00Z')), true);
  assert.equal(fullDiscoveryDue(new Date('2026-10-17T05:00:00Z'), Date.parse('2026-10-18T04:00:00Z')), false);
  assert.equal(fullDiscoveryDue(new Date('2026-10-17T05:00:00Z'), Date.parse('2026-10-18T05:00:00Z')), true);
});

test('Brightspace discovery accepts only broad or period-specific codes and paginates each query', async () => {
  const requested = [];
  const client = createSectionAssociationClient({ baseUrl: 'https://tenant.example', lpVersion: '1.60', oauth: {}, http: async () => {},
    get: async url => { requested.push(url); return { Items: [], PagingInfo: { HasMoreItems: false } }; } });
  await client.associationCandidates('2602-I0001');
  await client.associationCandidates('2601-I0001');
  await client.associationCandidates('I0001');
  assert.deepEqual(requested.map(url => new URL(url).searchParams.get('orgUnitCode')),
    ['2602-I0001', '2601-I0001', 'I0001']);
  assert.throws(() => client.associationCandidates('history-I0001'), /Invalid Section Association discovery code/);
});

function makeService({ time, failFull = false } = {}) {
  const calls = [];
  let fullAt = null;
  const association = { Identifier: 7, Code: '002521-01-2602-I0001', Type: { Code: 'Course Offering' } };
  const store = {
    async baselineStatus() { return { state: 'ready' }; },
    async lastFullDiscoveryAt() { return fullAt; },
    async markFullDiscoveryCompleted() { fullAt = new Date(time); },
    async recordDiscoveries() { return { newlyRecorded: 0, alreadyKnown: 0 }; },
    async countHistoricalBacklog() { return 0; }, async listWaitingNew() { return []; },
    async listFastWork(options) { calls.push(['work', options.includeCompletedReverification]); return []; }
  };
  const client = { async associationCandidates(code) {
    calls.push(['query', code]);
    if (code === 'I0001' && failFull) throw new Error('full scan failure');
    return code === 'I0001' ? [association] : [];
  } };
  const service = createSectionAssociationService({ client, store, reconciler: {}, now: () => time, logger: { info() {}, warn() {}, error() {} } });
  return { service, calls, store, get fullAt() { return fullAt; } };
}

test('nightly full discovery persists success once and resumes with period discovery on later invocations', async () => {
  const time = Date.parse('2026-10-18T05:15:00Z'); // 02:15 local
  const h = makeService({ time });
  assert.equal((await h.service.fastTick()).status, 'completed');
  assert.ok(h.fullAt instanceof Date);
  assert.deepEqual(h.calls.filter(([kind]) => kind === 'query').map(([, code]) => code), ['I0001', '2602-I0001', '2601-I0001']);
  h.calls.length = 0;
  assert.equal((await h.service.fastTick()).status, 'completed');
  assert.deepEqual(h.calls.filter(([kind]) => kind === 'query').map(([, code]) => code), ['2602-I0001', '2601-I0001']);
});

test('failed full discovery leaves its schedule unmarked for the next cron invocation', async () => {
  const h = makeService({ time: Date.parse('2026-10-18T05:15:00Z'), failFull: true });
  assert.equal((await h.service.fastTick()).status, 'completed');
  assert.equal(h.fullAt, null);
  assert.deepEqual(h.calls.filter(([kind]) => kind === 'query').map(([, code]) => code),
    ['I0001', '2602-I0001', '2601-I0001']);
});

test('completed re-verification is offered only during the maintenance window', async () => {
  const outside = makeService({ time: Date.parse('2026-10-18T09:15:00Z') });
  await outside.service.fastTick();
  assert.equal(outside.calls.find(([kind]) => kind === 'work')[1], false);
  const inside = makeService({ time: Date.parse('2026-10-18T06:15:00Z') });
  await inside.service.fastTick();
  assert.equal(inside.calls.find(([kind]) => kind === 'work')[1], true);
});

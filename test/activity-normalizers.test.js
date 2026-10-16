'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const n = require('../src/dates/activities/normalizers');
const { normalizeInstant, hasDates } = require('../src/dates/activities/normalizers');
const { id } = require('../src/shared/id');
const assignments = require('./fixtures/assignments.json');
const quizzes = require('./fixtures/quizzes.json').Objects;
const topics = require('./fixtures/discussion-topics.json');

test('assignment domain contract separates identity, dates and availability without native field duplication', () => {
  const a = n.normalizeAssignment(assignments[0], 999);
  assert.deepEqual(a, {
    key: 'assignment:999:11', type: 'assignment', id: '11', parentId: '2', name: 'Essay', orgUnitId: '999',
    dates: { start: '2026-09-01T09:00:00.000Z', due: '2026-09-20T23:59:00.000Z', end: '2026-09-30T23:59:00.000Z' },
    availability: { startType: { value: 0, name: 'AccessRestricted', label: 'Access restricted', state: 'known' },
      endType: { value: '2', name: 'Hidden', label: 'Hidden', state: 'known' } },
    identity: { activityId: 'assignment-a' }, metadata: { displayInCalendar: false }
  });
  assert.equal(n.normalizeAssignment(assignments[1], 999).dates.start, null);
  assert.equal(n.normalizeAssignment(assignments[2], 999).availability.startType.state, 'unspecified');
  assert.equal(n.normalizeAssignment(assignments[3], 999).availability.startType.state, 'missing');
  assert.equal(n.normalizeAssignment({ ...assignments[0], IsHidden: true }, 999).metadata.isHidden, true);
});

test('quiz mapping excludes passwords and returns UTC dates and category parent', () => {
  const q = n.normalizeQuiz(quizzes[0], '999');
  assert.equal(q.type, 'quiz'); assert.equal(q.id, '21'); assert.equal(q.parentId, '3');
  assert.equal(q.dates.start, '2026-09-02T00:00:00.000Z');
  assert.equal(q.metadata.isActive, false);
  assert.equal(JSON.stringify(q).includes('raw-only-secret'), false);
  assert.equal(hasDates(n.normalizeQuiz(quizzes[1], 999)), false);
});

test('discussion topic retains parent forum and availability', () => {
  const t = n.normalizeDiscussionTopic(topics[0], 999);
  assert.equal(t.type, 'discussionTopic'); assert.equal(t.parentId, '32');
  assert.equal(t.dates.due, '2026-09-03T00:00:00.000Z');
  assert.equal(t.availability.startType.value, 0);
  assert.equal(t.availability.endType.value, '2');
});


test('UTC normalization requires an explicit timezone, validates calendar dates and keeps precision', () => {
  assert.equal(normalizeInstant('2026-09-21T23:59:59-03:00'), '2026-09-22T02:59:59.000Z');
  assert.equal(normalizeInstant('2026-09-21T23:59:59.1234567-03:00'), '2026-09-22T02:59:59.1234567Z');
  assert.equal(normalizeInstant('2024-02-29T12:00:00Z'), '2024-02-29T12:00:00.000Z');
  assert.equal(normalizeInstant(null), null);
  for (const date of ['21/09/2026', '', '2026-09-21', '2026-09-21T01:00:00', '2026-02-30T00:00:00Z',
    '2025-02-29T00:00:00Z', '2026-01-01T24:00:00Z', '2026-01-01T00:00:00+25:00', 0, {}]) {
    assert.throws(() => normalizeInstant(date, 'start'), error => error.code === 'INVALID_DATE' && error.field === 'start');
  }
});

test('IDs reject objects, paths, unsafe numbers and missing values', () => {
  for (const value of [undefined, null, {}, ['999'], '1/2', '0', '-1', Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => id(value), TypeError);
  assert.equal(id('9007199254740993'), '9007199254740993');
});

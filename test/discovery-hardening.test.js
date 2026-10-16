'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const n = require('../src/dates/activities/normalizers');
const { hasDates } = require('../src/dates/activities/normalizers');
const { describeAvailabilityType } = require('../src/dates/activities/normalizers');
const normalizers = { assignment: n.normalizeAssignment, quiz: n.normalizeQuiz,
  discussionTopic: n.normalizeDiscussionTopic };
for (const f of require('./fixtures/date-cases.json')) {
  test(`${f.type}: ${f.case} dates, nulls and availability normalize independently`, () => {
    const before = structuredClone(f.row);
    const a = normalizers[f.type](f.row, '9524');
    assert.equal(a.type, f.type); assert.equal(a.key, `${f.type}:9524:101`);
    assert.deepEqual(a.dates, { start: f.expected.startDate, due: f.expected.dueDate, end: f.expected.endDate });
    assert.equal(hasDates(a), f.case !== 'null'); assert.deepEqual(f.row, before);
    if (f.type === 'assignment') assert.equal(a.availability.startType.value, 0);
  });
}

test('availability mapping preserves known, string, null, missing and future values', () => {
  for (const [value, name] of [[0, 'AccessRestricted'], [1, 'SubmissionRestricted'], [2, 'Hidden']]) {
    for (const raw of [value, String(value)]) {
      const a = describeAvailabilityType(raw); assert.equal(a.name, name); assert.equal(a.value, raw);
    }
  }
  assert.equal(describeAvailabilityType(null).state, 'unspecified');
  assert.equal(describeAvailabilityType(undefined, false).state, 'missing');
  for (const raw of [3, 'future', false, '', '00']) assert.equal(describeAvailabilityType(raw).state, 'unknown');
});

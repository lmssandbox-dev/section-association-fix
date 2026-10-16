'use strict';
const { hasDates } = require('../src/dates/activities/normalizers');
function assessDiscovery(result) {
  const activities = result.activities;
  const types = ['assignment', 'quiz', 'discussionTopic'];
  const checks = {
    complete: result.complete,
    noWarnings: result.warnings.length === 0,
    uniqueKeys: new Set(activities.map(a => a.key)).size === activities.length,
    correctOrgUnit: activities.every(a => a.orgUnitId === result.orgUnitId),
    onlyNativeTargets: activities.every(a => types.includes(a.type)),
    ...Object.fromEntries(types.flatMap(type => [
      [`dated_${type}`, activities.some(a => a.type === type && hasDates(a))],
      [`undated_${type}`, activities.some(a => a.type === type && !hasDates(a))]
    ])),
    ...Object.fromEntries(['start','due','end'].map(field => [`${field}Only`, activities.some(a =>
      a.dates[field] !== null && Object.entries(a.dates).every(([key,value]) => key === field || value === null))])),
    ...Object.fromEntries([0,1,2].map(value => [`assignmentAvailability${value}`, activities.some(a =>
      a.type === 'assignment' && Object.values(a.availability).some(t => String(t.value) === String(value)))])),
    utcDates: activities.every(a => Object.values(a.dates).every(d => d === null || /^\d{4}-\d{2}-\d{2}T.*Z$/.test(d)))
  };
  return { passed: Object.values(checks).every(Boolean), checks };
}
module.exports = { assessDiscovery };

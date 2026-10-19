'use strict';

const { randomUUID } = require('node:crypto');

function startMaintenanceExecution(source, now = Date.now) {
  if (!['automatic', 'manual'].includes(source)) throw new Error('Maintenance execution source must be automatic or manual.');
  return { executionId: randomUUID(), source, startedAt: new Date(now()) };
}

function buildMaintenanceExecutionSummary(execution, { status, results = [], executionErrors = 0, now = Date.now } = {}) {
  const summary = { ...execution, completedAt: new Date(now()), status, detailedAuditAvailable: execution.auditIncomplete !== true };
  delete summary.auditIncomplete;
  const counters = [
    ['associationsChecked', 'associationsChecked'],
    ['alreadyCompliant', 'associationsAlreadyCompliant'],
    ['correctionsApplied', 'correctionsApplied'],
    ['errors', 'errors']
  ];
  for (const [field, resultField] of counters) {
    if (results.length && results.every(result => Number.isSafeInteger(result?.[resultField]) && result[resultField] >= 0)) {
      summary[field] = results.reduce((total, result) => total + result[resultField], 0);
    }
  }
  if (executionErrors > 0) summary.errors = (summary.errors || 0) + executionErrors;
  const validPeriod = period => /^\d{2}0[12]$/.test(period || '');
  const periodsResult = [...results].reverse().find(result => {
    const periods = result?.discoveryPeriods;
    return periods?.mode === 'all' || (['auto', 'explicit'].includes(periods?.mode) &&
      Array.isArray(periods.periods) && periods.periods.every(validPeriod));
  });
  if (periodsResult) summary.discoveryPeriods = { mode: periodsResult.discoveryPeriods.mode,
    periods: [...(periodsResult.discoveryPeriods.periods || [])], ...(periodsResult.discoveryPeriods.previous ? {
      previous: periodsResult.discoveryPeriods.previous, current: periodsResult.discoveryPeriods.current,
      next: periodsResult.discoveryPeriods.next } : {}) };
  else {
    const legacyPeriods = [...results].reverse().find(result =>
      /^\d{4}$/.test(result?.discoveryPeriods?.current || '') && /^\d{4}$/.test(result?.discoveryPeriods?.previous || ''));
    if (legacyPeriods) summary.discoveryPeriods = { ...legacyPeriods.discoveryPeriods };
  }
  const discoveryActivities = {};
  for (const result of results) {
    for (const [activity, performed] of Object.entries(result?.discoveryActivities || {})) {
      if (performed === true) discoveryActivities[activity] = true;
    }
  }
  if (Object.keys(discoveryActivities).length) summary.discoveryActivities = discoveryActivities;
  const coverageResult = [...results].reverse().find(result => Number.isSafeInteger(result?.remainingHistoricalBacklog) && result.remainingHistoricalBacklog >= 0);
  if (coverageResult) summary.coverage = { type: 'bounded-cycle', remainingHistoricalBacklog: coverageResult.remainingHistoricalBacklog };
  return summary;
}

async function persistMaintenanceExecution(store, summary, logger = console) {
  try { await store.saveMaintenanceExecution(summary); return true; }
  catch {
    logger.warn?.(`[section-association] execution summary persistence failed source=${summary.source}`);
    return false;
  }
}

module.exports = { startMaintenanceExecution, buildMaintenanceExecutionSummary, persistMaintenanceExecution };

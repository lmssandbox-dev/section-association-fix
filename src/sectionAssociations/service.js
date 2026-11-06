'use strict';

const { isAssociation, originalOfferingCode } = require('./rules');
const { logEvent, safeErrorFields } = require('./log');

const ACADEMIC_TIME_ZONE = 'America/Sao_Paulo';

function localParts(value) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: ACADEMIC_TIME_ZONE, year: 'numeric',
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value));
  return Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
}

function academicPeriods(value = Date.now()) {
  const { year, month } = localParts(value);
  const semester = month <= 6 ? 1 : 2;
  const currentYear = year % 100;
  const previousYear = semester === 1 ? (currentYear + 99) % 100 : currentYear;
  const previousSemester = semester === 1 ? 2 : 1;
  const nextYear = semester === 1 ? currentYear : (currentYear + 1) % 100;
  const nextSemester = semester === 1 ? 2 : 1;
  const current = `${String(currentYear).padStart(2, '0')}0${semester}`;
  const previous = `${String(previousYear).padStart(2, '0')}0${previousSemester}`;
  const next = `${String(nextYear).padStart(2, '0')}0${nextSemester}`;
  return { mode: 'auto', previous, current, next, periods: [previous, current, next] };
}

function discoveryScope(configuration = { mode: 'auto' }, value = Date.now()) {
  if (configuration.mode === 'all') return { mode: 'all', periods: [] };
  if (configuration.mode === 'explicit') return { mode: 'explicit', periods: [...configuration.periods] };
  return academicPeriods(value);
}

function isReverificationWindow(value = Date.now()) {
  const { hour, minute } = localParts(value);
  return hour >= 1 && hour < 7 && (minute === 0 || minute === 30);
}

function isRegularOperationsWindow(value = Date.now()) {
  const { hour } = localParts(value);
  return hour >= 7 && hour < 23;
}

function isHistoricalDiscoveryWindow(value = Date.now()) {
  const { hour } = localParts(value);
  return hour === 23 || hour === 0;
}

function localHourKey(value = Date.now()) {
  const { year, month, day, hour } = localParts(value);
  return new Date(Date.UTC(year, month - 1, day, hour) - localOffsetMs(value));
}

function localDayStart(value = Date.now()) {
  const { year, month, day } = localParts(value);
  return new Date(Date.UTC(year, month - 1, day) - localOffsetMs(value));
}

function localOffsetMs(value) {
  const date = new Date(value);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: ACADEMIC_TIME_ZONE, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const local = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
  return Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second) - Math.floor(date.getTime() / 1000) * 1000;
}

function historicalWindowKey(value = Date.now()) {
  const { year, month, day, hour } = localParts(value);
  const localDate = new Date(Date.UTC(year, month - 1, day - (hour === 0 ? 1 : 0)));
  return `${localDate.getUTCFullYear()}-${String(localDate.getUTCMonth() + 1).padStart(2, '0')}-${String(localDate.getUTCDate()).padStart(2, '0')}`;
}

function fullDiscoveryDue(lastCompletedAt, value = Date.now()) {
  if (!isHistoricalDiscoveryWindow(value)) return false;
  return !lastCompletedAt || historicalWindowKey(lastCompletedAt) !== historicalWindowKey(value);
}

function createSectionAssociationService({ client, store, reconciler, stabilityMinutes = 10,
  maxReconciliationsPerRun = 50, recoveryIntervalHours = 4, completedReverifyHours = 24,
  discoveryConfiguration = { mode: 'auto', periods: [] }, childMonitoringBatchSize = 125,
  statusVerificationBatchSize = 150, now = Date.now, logger = console }) {
  let busy = false;
  const stabilityLogged = new Set();
  const attemptedByExecution = new WeakMap();
  const recoveryIntervalMs = recoveryIntervalHours * 60 * 60 * 1000;
  const completedReverifyMs = completedReverifyHours * 60 * 60 * 1000;

  async function discover(orgUnitCode) {
    const candidates = await client.associationCandidates(orgUnitCode);
    const valid = candidates.filter(item => isAssociation(item) && /^\d+$/.test(String(item.Identifier ?? item.OrgUnitId ?? '')));
    const discoveredIds = [...new Set(candidates.filter(item => /^\d+$/.test(String(item?.Identifier ?? item?.OrgUnitId ?? '')))
      .map(item => String(item?.Identifier ?? item?.OrgUnitId)))];
    const results = [...new Map(valid.map(item => [String(item.Identifier ?? item.OrgUnitId), item])).values()];
    Object.defineProperty(results, 'discoveredIds', { value: discoveredIds });
    return results;
  }

  async function bootstrap(associations, discoveryOptions = {}) {
    const token = await store.beginBaseline();
    if (!token) return null;
    try {
      const counts = await store.finishBaseline(token, associations.map(item => ({ id: item.Identifier ?? item.OrgUnitId, code: item.Code })), discoveryOptions);
      const result = { newlyRecorded: counts?.newlyRecorded || 0, alreadyKnown: counts?.alreadyKnown || 0 };
      logEvent(logger, 'info', 'baseline recorded', { candidates: associations.length });
      return result;
    } catch (error) { await store.releaseBaseline(token); throw error; }
  }

  function logDiscovery(stats) {
    logEvent(logger, 'info', 'discovery completed', { candidates: stats.discovered, new: stats.new, alreadyKnown: stats.alreadyKnown });
  }

  function logStabilityWait(id) {
    if (stabilityLogged.has(id)) return;
    stabilityLogged.add(id);
    logEvent(logger, 'info', 'pending', { associationId: id, reason: 'stability-window' });
  }

  function countStatus(stats, result) {
    if (result?.status === 'completed') stats.completed++;
    else if (result?.status === 'blocked') stats.blocked++;
    else stats.pending++;
    stats.associationsChecked++;
    if (Array.isArray(result?.targets) && result.targets.length > 0 &&
        result.targets.every(target => target.status === 'already-inactive')) stats.associationsAlreadyCompliant++;
    if ((result?.writesVerified || 0) > 0) stats.correctionsApplied++;
    if (result?.status === 'blocked' || result?.error) stats.errors++;
    stats.writesAttempted += result?.writesAttempted || 0;
    stats.writesVerified += result?.writesVerified || 0;
    stats.alreadyInactive += result?.alreadyInactive || 0;
  }

  async function prepareDiscovery(stats, setPhase = () => {}, execution, manualDiscovery = false) {
    const currentTime = now();
    setPhase('database');
    const baselineStatus = typeof store.baselineStatus === 'function' ? await store.baselineStatus() : { state: 'ready' };
    const baselineRequired = !baselineStatus || baselineStatus.state !== 'ready';
    const lastFull = typeof store.lastFullDiscoveryAt === 'function' ? await store.lastFullDiscoveryAt() : new Date(currentTime);
    const configuredScope = discoveryScope(discoveryConfiguration, currentTime);
    const scope = manualDiscovery && configuredScope.mode === 'all' ? academicPeriods(currentTime) : configuredScope;
    const broadWindow = isHistoricalDiscoveryWindow(currentTime);
    const regularWindow = isRegularOperationsWindow(currentTime);
    const runFullDiscovery = !manualDiscovery && broadWindow && (baselineRequired || fullDiscoveryDue(lastFull, currentTime));
    if (!manualDiscovery && !regularWindow && !runFullDiscovery && scope.mode !== 'all') return true;
    if (!manualDiscovery && scope.mode === 'all' && !regularWindow && !runFullDiscovery) return true;
    setPhase('discovery');
    let full = [];
    const fullByFormat = {};
    let fullDiscoveryAt;
    let fullDiscoveryError;
    if (runFullDiscovery) {
      try {
        fullByFormat.legacy = await discover('I0001');
        fullByFormat.peoplesoft = await discover('ESPM-');
        full = [...new Map([...fullByFormat.legacy, ...fullByFormat.peoplesoft]
          .map(item => [String(item.Identifier ?? item.OrgUnitId), item])).values()];
        Object.defineProperty(full, 'discoveredIds', { value: [...new Set([
          ...(fullByFormat.legacy.discoveredIds || []), ...(fullByFormat.peoplesoft.discoveredIds || [])]) ] });
        fullDiscoveryAt = new Date(now());
        if (runFullDiscovery || scope.mode === 'all') stats.discoveryActivities.historical = true;
      }
      catch (error) {
        if (baselineRequired || scope.mode === 'all') throw error;
        fullDiscoveryError = error;
        logEvent(logger, 'warn', 'full discovery deferred', safeErrorFields(error, {
          phase: error?.phase || 'discovery', endpoint: error?.endpoint || 'association-candidates'
        }));
      }
    }
    setPhase('database');
    let baseline = baselineStatus;
    const fullIds = new Set(full.map(item => String(item.Identifier ?? item.OrgUnitId)));
    const discoveryOptions = results => ({ observedIds: results.flatMap(result => result?.discoveredIds || []),
      onRestored: item => logEvent(logger, 'info', 'association restored', { associationId: item.id, code: item.code }) });
    const confirmMissing = async options => {
      if (typeof store.confirmMissing !== 'function') return;
      await store.confirmMissing({ ...options, execution, recordAudit: store.recordAudit,
        onConfirmed: (item, coverage) => logEvent(logger, 'warn', 'association marked missing', {
          associationId: item.associationOrgUnitId, code: item.associationCode, reason: 'discovery-absence' }) });
    };
    if ((!baseline || baseline.state !== 'ready') && runFullDiscovery) {
      const counts = await bootstrap(full, discoveryOptions([full]));
      if (!counts) {
        baseline = await store.baselineStatus();
        if (!baseline || baseline.state !== 'ready') return false;
        const persisted = await store.recordDiscoveries(full.map(item => ({ id: item.Identifier ?? item.OrgUnitId, code: item.Code })), discoveryOptions([full]));
        stats.new += persisted.newlyRecorded;
        stats.alreadyKnown += persisted.alreadyKnown;
      } else {
        stats.new += counts.newlyRecorded;
        stats.alreadyKnown += counts.alreadyKnown;
        baseline = { state: 'ready' };
      }
    } else if (baseline?.state === 'ready' && runFullDiscovery && !fullDiscoveryError) {
      const counts = await store.recordDiscoveries(full.map(item => ({ id: item.Identifier ?? item.OrgUnitId, code: item.Code })), discoveryOptions([full]));
      stats.new += counts.newlyRecorded;
      stats.alreadyKnown += counts.alreadyKnown;
    }
    if (fullDiscoveryAt && (runFullDiscovery || scope.mode === 'all') && baseline?.state === 'ready') {
      for (const format of ['legacy', 'peoplesoft']) {
        await confirmMissing({ broad: true, format, discoveredIds: fullByFormat[format].discoveredIds || [], discoveryAt: fullDiscoveryAt });
      }
    }
    if (runFullDiscovery && !fullDiscoveryError && typeof store.markFullDiscoveryCompleted === 'function') {
      await store.markFullDiscoveryCompleted();
    }
    setPhase('discovery');
    const periodResults = [];
    if (scope.mode !== 'all' && (regularWindow || manualDiscovery)) {
      // Keep Brightspace discovery bounded and retain separate absence evidence for each code family.
      for (const period of scope.periods) {
        const legacy = await discover(`${period}-I0001`);
        const peoplesoft = await discover(`ESPM-${period}-`);
        periodResults.push({ period, legacy, peoplesoft });
      }
    }
    const periodDiscoveryAt = periodResults.length ? new Date(now()) : null;
    if (periodResults.length || (scope.mode === 'all' && runFullDiscovery)) stats.discoveryPeriods = scope;
    if (scope.mode !== 'all' && periodResults.length) stats.discoveryActivities.periods = true;
    const flatPeriodResults = periodResults.flatMap(result => [result.legacy, result.peoplesoft]);
    const associations = [...new Map([...full, ...flatPeriodResults.flat()]
      .map(item => [String(item.Identifier ?? item.OrgUnitId), item])).values()];
    stats.discovered = associations.length;
    setPhase('database');
    if (baseline?.state === 'ready') {
      const discoveryRecords = ((runFullDiscovery || scope.mode === 'all') && !fullDiscoveryError
        ? associations.filter(item => !fullIds.has(String(item.Identifier ?? item.OrgUnitId)))
        : associations)
        .map(item => ({ id: item.Identifier ?? item.OrgUnitId, code: item.Code }));
      const periodObservedIds = flatPeriodResults.flatMap(result => result?.discoveredIds || []);
      if (discoveryRecords.length || periodObservedIds.length) {
        const counts = await store.recordDiscoveries(discoveryRecords, discoveryOptions(flatPeriodResults));
        stats.new += counts.newlyRecorded;
        stats.alreadyKnown += counts.alreadyKnown;
      }
      if (periodDiscoveryAt && typeof store.confirmMissing === 'function') {
        for (const result of periodResults) {
          for (const format of ['legacy', 'peoplesoft']) {
            const matches = result[format];
            await confirmMissing({ periods: [result.period], format,
              discoveredIds: matches.discoveredIds || matches.map(item => String(item.Identifier ?? item.OrgUnitId)), discoveryAt: periodDiscoveryAt });
          }
        }
      }
    } else if (flatPeriodResults.length) {
      const records = [...new Map(flatPeriodResults.flat().map(item => [String(item.Identifier ?? item.OrgUnitId),
        { id: item.Identifier ?? item.OrgUnitId, code: item.Code }])).values()];
      const counts = await store.recordDiscoveries(records, discoveryOptions(flatPeriodResults));
      stats.new += counts.newlyRecorded;
      stats.alreadyKnown += counts.alreadyKnown;
    }
    logDiscovery(stats);
    return true;
  }

  async function processWork(items, stats, execution) {
    let attempted;
    if (execution && typeof execution === 'object') {
      attempted = attemptedByExecution.get(execution);
      if (!attempted) { attempted = new Set(); attemptedByExecution.set(execution, attempted); }
    }
    for (const item of items) {
      const id = String(item.associationOrgUnitId);
      if (attempted?.has(id)) continue;
      attempted?.add(id);
      stabilityLogged.delete(id);
      if (item.workType === 'reverify') stats.discoveryActivities.reverification = true;
      const result = await reconciler.reconcileAssociation(id, { associationCode: item.associationCode, force: true,
        execution, recordAudit: store.recordAudit });
      stats.processedThisRun++;
      countStatus(stats, result);
    }
  }

  function monitoringPeriods(time) {
    const scope = discoveryScope(discoveryConfiguration, time);
    const rolling = academicPeriods(time).periods;
    return scope.mode === 'explicit' ? scope.periods.filter(period => rolling.includes(period)) : rolling;
  }

  function normalizedChildren(rows) {
    return rows.map(row => ({ id: String(row.Identifier ?? row.OrgUnitId ?? ''), code: String(row.Code || '') }))
      .sort((a, b) => a.id.localeCompare(b.id) || a.code.localeCompare(b.code));
  }

  function trustedMapping(item) {
    if (item.verifiedMappingVersion !== 1 || !Array.isArray(item.verifiedChildren) || !Array.isArray(item.verifiedTargets) ||
        !Array.isArray(item.verifiedMappings) || item.verifiedChildren.length < 1 ||
        item.verifiedChildren.length !== item.verifiedTargets.length || item.verifiedChildren.length !== item.verifiedMappings.length) return false;
    if ([...item.verifiedChildren, ...item.verifiedTargets, ...item.verifiedMappings].some(row => !row || typeof row !== 'object')) return false;
    const sectionIds = new Set(item.verifiedMappings.map(mapping => String(mapping.sectionId)));
    const targetIds = new Set(item.verifiedMappings.map(mapping => String(mapping.targetId)));
    if (sectionIds.size !== item.verifiedChildren.length || targetIds.size !== item.verifiedTargets.length) return false;
    if (item.verifiedChildren.some(child => !/^\d+$/.test(String(child.id)) || !child.code) ||
        item.verifiedTargets.some(target => !/^\d+$/.test(String(target.id)) || !target.code)) return false;
    return item.verifiedMappings.every(mapping => {
      const child = item.verifiedChildren.find(row => String(row.id) === String(mapping.sectionId) && row.code === mapping.sectionCode);
      const target = item.verifiedTargets.find(row => String(row.id) === String(mapping.targetId) && row.code === mapping.targetCode);
      if (!child || !target) return false;
      try { return originalOfferingCode(child.code) === target.code; } catch { return false; }
    });
  }

  async function monitorChildren(stats, execution, remaining) {
    if (!isRegularOperationsWindow(now()) || typeof store.listMonitoringWork !== 'function') return;
    const time = now();
    const items = await store.listMonitoringWork({ kind: 'children', periods: monitoringPeriods(time),
      limit: childMonitoringBatchSize, windowKey: localHourKey(time), attemptCutoff: new Date(time - 60 * 60000) });
    stats.monitoringPeriods = monitoringPeriods(time);
    stats.monitoringActivities.children = true;
    const attemptField = 'lastChildInspectionAttemptAt';
    const changed = [];
    let mappingsNeedRefresh = 0;
    let childChangesDetected = 0;
    for (const item of items) {
      const id = String(item.associationOrgUnitId);
      await store.record(id, { [attemptField]: new Date(now()) });
      if (!trustedMapping(item)) {
        changed.push(item);
        mappingsNeedRefresh++;
        continue;
      }
      let currentRows;
      try {
        stats.childChecksAttempted++;
        currentRows = await client.children(id);
      } catch (error) {
        stats.monitoringErrors++;
        logEvent(logger, 'warn', 'child monitoring failed', safeErrorFields(error, { associationId: id, phase: 'children-read' }));
        continue;
      }
      const current = normalizedChildren(currentRows);
      const previous = normalizedChildren(item.verifiedChildren || []);
      if (currentRows.some(row => row?.Type?.Code !== 'Group') || JSON.stringify(current) !== JSON.stringify(previous)) {
        changed.push(item); childChangesDetected++;
      } else await store.record(id, { lastSuccessfulChildInspectionAt: new Date(now()) });
      stats.childChecksSucceeded++;
    }
    stats.childChangesDetected += childChangesDetected;
    stats.mappingRefreshesRequired += mappingsNeedRefresh;
    if (changed.length) await processWork(changed.slice(0, remaining), stats, execution);
    stats.childMonitoringLag = await store.countDueMonitoring?.({ kind: 'children', periods: monitoringPeriods(time), before: localHourKey(time) }) ?? null;
  }

  async function verifyCachedTargets(stats, execution, reconciliationLimit) {
    const time = now();
    if (!isReverificationWindow(time) || typeof store.listMonitoringWork !== 'function') return;
    const items = await store.listMonitoringWork({ kind: 'status', periods: monitoringPeriods(time),
      limit: statusVerificationBatchSize, windowKey: localDayStart(time), attemptCutoff: new Date(time - 60 * 60000) });
    stats.monitoringPeriods = monitoringPeriods(time);
    stats.monitoringActivities.status = true;
    const attemptField = 'lastStatusVerificationAttemptAt';
    const reconcile = [];
    let mappingsNeedRefresh = 0;
    let statusChangesDetected = 0;
    for (const item of items) {
      const id = String(item.associationOrgUnitId);
      await store.record(id, { [attemptField]: new Date(now()) });
      const mappings = Array.isArray(item.verifiedTargets) ? item.verifiedTargets : [];
      if (!trustedMapping(item)) { reconcile.push(item); mappingsNeedRefresh++; continue; }
      let requiresReconcile = false;
      try {
        stats.statusChecksAttempted++;
        for (const mapping of mappings) {
          if (!/^\d+$/.test(String(mapping.id || '')) || typeof mapping.code !== 'string' || !mapping.code) { requiresReconcile = true; break; }
          const course = await client.course(mapping.id);
          const actualId = String(course?.Identifier ?? course?.OrgUnitId ?? '');
          if (actualId !== String(mapping.id) || course?.Type?.Code !== 'Course Offering' || course?.Code !== mapping.code || course?.IsActive !== false) {
            requiresReconcile = true; break;
          }
        }
      } catch (error) {
        if (error?.status === 404) {
          reconcile.push(item);
          statusChangesDetected++;
          continue;
        }
        stats.monitoringErrors++;
        logEvent(logger, 'warn', 'cached status verification failed', safeErrorFields(error, { associationId: id, phase: 'target-read' }));
        continue;
      }
      stats.statusChecksSucceeded++;
      if (requiresReconcile) { reconcile.push(item); statusChangesDetected++; }
      else await store.record(id, { lastSuccessfulStatusVerificationAt: new Date(now()) });
    }
    const remaining = Math.max(0, reconciliationLimit - stats.processedThisRun);
    stats.mappingRefreshesRequired += mappingsNeedRefresh;
    if (reconcile.length && remaining) await processWork(reconcile.slice(0, remaining), stats, execution);
    stats.statusChangesDetected += statusChangesDetected;
    stats.statusMonitoringLag = await store.countDueMonitoring?.({ kind: 'status', periods: monitoringPeriods(time), before: localDayStart(time) }) ?? null;
  }

  function newStats(discovered = 0) {
    return { candidates: discovered, discovered, new: 0, alreadyKnown: 0, pending: 0, historicalPending: 0,
      blocked: 0, completed: 0, dueForReverification: 0, processedThisRun: 0, remainingHistoricalBacklog: null,
      associationsChecked: 0, associationsAlreadyCompliant: 0, correctionsApplied: 0, errors: 0,
      writesAttempted: 0, writesVerified: 0, alreadyInactive: 0, childChecksAttempted: 0, childChecksSucceeded: 0,
      childChangesDetected: 0, childMonitoringLag: null, statusChecksAttempted: 0, statusChecksSucceeded: 0,
      statusChangesDetected: 0, statusMonitoringLag: null, monitoringErrors: 0, mappingRefreshesRequired: 0,
      monitoringPeriods: null, monitoringActivities: {}, discoveryActivities: {} };
  }

  async function runCycle({ recovery = false, discoveryAlreadyCompleted = false,
    maxReconciliations = maxReconciliationsPerRun, execution, manualDiscovery = false } = {}) {
    const startedAt = now();
    const name = recovery ? 'recovery cycle' : 'fast cycle';
    logEvent(logger, 'info', `${name} started`);
    const stats = newStats();
    if (busy) {
      logEvent(logger, 'warn', `${name} skipped`, { reason: 'already-running' });
      logEvent(logger, 'info', `${name} finished`, { status: 'skipped', elapsedMs: Math.max(0, now() - startedAt) });
      return { status: 'skipped', processedThisRun: 0 };
    }
    busy = true;
    let phase = 'discovery';
    let succeeded = false;
    let recoveryComplete = true;
    try {
      if (!discoveryAlreadyCompleted && !await prepareDiscovery(stats, value => { phase = value; }, execution, manualDiscovery)) {
        succeeded = true;
        return { status: 'completed', ...stats, recoveryComplete: false };
      }
      phase = 'database';
      const time = now();
      const stabilityCutoff = new Date(time - stabilityMinutes * 60000);
      stats.historicalPending = await store.countHistoricalBacklog();
      if (recovery) {
        const items = await store.listRecoveryWork({ limit: maxReconciliations,
          stabilityCutoff, blockedBefore: new Date(time - recoveryIntervalMs) });
        await processWork(items, stats, execution);
        recoveryComplete = await store.countRecoveryWork({ stabilityCutoff,
          blockedBefore: new Date(time - recoveryIntervalMs) }) === 0;
        if (!recoveryComplete) logEvent(logger, 'warn', 'recovery deferred', { reason: 'work-remains' });
      } else {
        for (const item of await store.listWaitingNew({ stabilityCutoff })) {
          stats.pending++;
          logStabilityWait(item.associationOrgUnitId);
        }
        const items = await store.listFastWork({ limit: maxReconciliations, stabilityCutoff,
          includeCompletedReverification: false, reverifyBefore: new Date(time - completedReverifyMs) });
        await processWork(items, stats, execution);
      }
      if (!recovery) {
        phase = 'monitoring';
        if (isRegularOperationsWindow(time)) await monitorChildren(stats, execution,
          Math.max(0, maxReconciliations - stats.processedThisRun));
        else if (isReverificationWindow(time)) await verifyCachedTargets(stats, execution, maxReconciliations);
      }
      stats.remainingHistoricalBacklog = await store.countHistoricalBacklog();
      succeeded = true;
      return { status: 'completed', ...stats, recoveryComplete };
    } catch (error) {
      const errorPhase = error?.phase || phase;
      const endpoint = error?.endpoint || (errorPhase === 'oauth' ? 'oauth-token' : ['discovery', 'oauth/api-read'].includes(errorPhase) ? 'association-candidates' : undefined);
      logEvent(logger, 'error', recovery ? 'recovery cycle failed' : 'fast cycle failed', safeErrorFields(error, {
        phase: errorPhase, endpoint, elapsedMs: Math.max(0, now() - startedAt)
      }));
      stats.errors++;
      return { status: 'failed', phase: errorPhase, code: error?.code, ...stats };
    } finally {
      busy = false;
      if (succeeded) logEvent(logger, 'info', recovery ? 'recovery cycle completed' : 'fast cycle completed', stats);
      logEvent(logger, 'info', `${name} finished`, { status: succeeded ? 'completed' : 'failed', elapsedMs: Math.max(0, now() - startedAt) });
    }
  }

  async function fastTick(options) { return runCycle(options); }
  async function recoveryTick(options) { return runCycle({ ...options, recovery: true }); }

  return { discover, fastTick, recoveryTick };
}

module.exports = { createSectionAssociationService, academicPeriods, discoveryScope, isReverificationWindow,
  isRegularOperationsWindow, isHistoricalDiscoveryWindow, historicalWindowKey, fullDiscoveryDue };

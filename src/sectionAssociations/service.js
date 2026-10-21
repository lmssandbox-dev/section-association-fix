'use strict';

const { isAssociation } = require('./rules');
const { logEvent, safeErrorFields } = require('./log');

const ACADEMIC_TIME_ZONE = 'America/Sao_Paulo';

function localParts(value) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: ACADEMIC_TIME_ZONE, year: 'numeric',
    month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value));
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
  const { hour } = localParts(value);
  return hour >= 3 && hour < 6;
}

function localDateKey(value = Date.now()) {
  const { year, month, day } = localParts(value);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function fullDiscoveryDue(lastCompletedAt, value = Date.now()) {
  const { hour } = localParts(value);
  if (!lastCompletedAt) return true;
  if (hour < 2) return false;
  return localDateKey(lastCompletedAt) !== localDateKey(value) || localParts(lastCompletedAt).hour < 2;
}

function createSectionAssociationService({ client, store, reconciler, stabilityMinutes = 10,
  maxReconciliationsPerRun = 50, recoveryIntervalHours = 4, completedReverifyHours = 24,
  discoveryConfiguration = { mode: 'auto', periods: [] }, now = Date.now, logger = console }) {
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

  async function prepareDiscovery(stats, setPhase = () => {}, execution) {
    const currentTime = now();
    setPhase('database');
    const baselineStatus = typeof store.baselineStatus === 'function' ? await store.baselineStatus() : { state: 'ready' };
    const baselineRequired = !baselineStatus || baselineStatus.state !== 'ready';
    const lastFull = typeof store.lastFullDiscoveryAt === 'function' ? await store.lastFullDiscoveryAt() : new Date(currentTime);
    const scope = discoveryScope(discoveryConfiguration, currentTime);
    const runFullDiscovery = baselineRequired || fullDiscoveryDue(lastFull, currentTime);
    setPhase('discovery');
    let full = [];
    let fullDiscoveryAt;
    let fullDiscoveryError;
    if (scope.mode === 'all' || runFullDiscovery) {
      try {
        full = await discover('I0001');
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
    if (!baseline || baseline.state !== 'ready') {
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
    } else if ((runFullDiscovery || scope.mode === 'all') && !fullDiscoveryError) {
      const counts = await store.recordDiscoveries(full.map(item => ({ id: item.Identifier ?? item.OrgUnitId, code: item.Code })), discoveryOptions([full]));
      stats.new += counts.newlyRecorded;
      stats.alreadyKnown += counts.alreadyKnown;
    }
    if (fullDiscoveryAt && (runFullDiscovery || scope.mode === 'all') && baseline?.state === 'ready') {
      await confirmMissing({ broad: true, discoveredIds: full.discoveredIds || [...fullIds], discoveryAt: fullDiscoveryAt });
    }
    if ((runFullDiscovery || scope.mode === 'all') && !fullDiscoveryError && typeof store.markFullDiscoveryCompleted === 'function') {
      await store.markFullDiscoveryCompleted();
    }
    setPhase('discovery');
    const periodResults = scope.mode === 'all' ? [] : await Promise.all(scope.periods.map(period => discover(`${period}-I0001`)));
    const periodDiscoveryAt = periodResults.length ? new Date(now()) : null;
    stats.discoveryPeriods = scope;
    if (scope.mode !== 'all') stats.discoveryActivities.periods = true;
    const associations = [...new Map([...full, ...periodResults.flat()]
      .map(item => [String(item.Identifier ?? item.OrgUnitId), item])).values()];
    stats.discovered = associations.length;
    setPhase('database');
    if (baseline?.state === 'ready') {
      const discoveryRecords = ((runFullDiscovery || scope.mode === 'all') && !fullDiscoveryError
        ? associations.filter(item => !fullIds.has(String(item.Identifier ?? item.OrgUnitId)))
        : associations)
        .map(item => ({ id: item.Identifier ?? item.OrgUnitId, code: item.Code }));
      const periodObservedIds = periodResults.flatMap(result => result?.discoveredIds || []);
      if (discoveryRecords.length || periodObservedIds.length) {
        const counts = await store.recordDiscoveries(discoveryRecords, discoveryOptions(periodResults));
        stats.new += counts.newlyRecorded;
        stats.alreadyKnown += counts.alreadyKnown;
      }
      if (periodDiscoveryAt && typeof store.confirmMissing === 'function') {
        for (let index = 0; index < scope.periods.length; index++) {
          const result = periodResults[index] || [];
          await confirmMissing({ periods: [scope.periods[index]],
            discoveredIds: result.discoveredIds || result.map(item => String(item.Identifier ?? item.OrgUnitId)), discoveryAt: periodDiscoveryAt });
        }
      }
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

  function newStats(discovered = 0) {
    return { candidates: discovered, discovered, new: 0, alreadyKnown: 0, pending: 0, historicalPending: 0,
      blocked: 0, completed: 0, dueForReverification: 0, processedThisRun: 0, remainingHistoricalBacklog: null,
      associationsChecked: 0, associationsAlreadyCompliant: 0, correctionsApplied: 0, errors: 0,
      writesAttempted: 0, writesVerified: 0, alreadyInactive: 0, discoveryActivities: {} };
  }

  async function runCycle({ recovery = false, discoveryAlreadyCompleted = false,
    maxReconciliations = maxReconciliationsPerRun, execution } = {}) {
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
      if (!discoveryAlreadyCompleted && !await prepareDiscovery(stats, value => { phase = value; }, execution)) {
        succeeded = true;
        return { status: 'completed', ...stats, recoveryComplete: false };
      }
      phase = 'database';
      const time = now();
      const stabilityCutoff = new Date(time - stabilityMinutes * 60000);
      stats.historicalPending = await store.countHistoricalBacklog();
      if (recovery) {
        const reverifyBefore = new Date(time - completedReverifyMs);
        stats.dueForReverification = isReverificationWindow(time) ? await store.countDueCompleted(reverifyBefore) : 0;
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
          includeCompletedReverification: isReverificationWindow(time),
          reverifyBefore: new Date(time - completedReverifyMs) });
        await processWork(items, stats, execution);
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

module.exports = { createSectionAssociationService, academicPeriods, discoveryScope, isReverificationWindow, fullDiscoveryDue };

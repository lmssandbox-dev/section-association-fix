'use strict';

const { isAssociation } = require('./rules');
const { resolveTargets } = require('./resolver');
const { logEvent } = require('./log');

const RECONCILIATION_VERSION = 1;

function richTextInput(description) {
  if (description == null) throw new Error('Course Description has an unsupported format.');
  if (typeof description === 'string') return { Content: description, Type: 'Text' };
  if (typeof description !== 'object' || Array.isArray(description)) throw new Error('Course Description has an unsupported format.');
  if (typeof description.Html === 'string' && description.Html) return { Content: description.Html, Type: 'Html' };
  if (typeof description.Text === 'string') return { Content: description.Text, Type: 'Text' };
  throw new Error('Course Description cannot be safely converted for update.');
}

function courseUpdatePayload(course) {
  const required = ['Name', 'Code', 'StartDate', 'EndDate', 'LocaleId', 'ForceLocale', 'ShowAddressBook', 'IsActive', 'Description', 'CanSelfRegister'];
  for (const key of required) if (!Object.hasOwn(course || {}, key)) throw new Error(`Current Course Offering is missing ${key}.`);
  if (typeof course.Name !== 'string' || typeof course.Code !== 'string' || typeof course.IsActive !== 'boolean') throw new Error('Current Course Offering contains invalid fields.');
  return {
    Name: course.Name, Code: course.Code, StartDate: course.StartDate, EndDate: course.EndDate,
    LocaleId: course.LocaleId, ForceLocale: course.ForceLocale, ShowAddressBook: course.ShowAddressBook,
    IsActive: false, Description: richTextInput(course.Description), CanSelfRegister: course.CanSelfRegister
  };
}

function createReconciler({ client, store, dryRun = true, now = Date.now, logger = console }) {
  async function reconcileAssociation(associationOrgUnitId, { force = false, associationCode: requestedCode, execution, recordAudit } = {}) {
    const id = String(associationOrgUnitId);
    const existing = await store.get(id);
    if (!force && hasVerifiedCompletion(existing)) return { status: 'completed', skipped: true };
    let associationCode = requestedCode || existing?.associationCode || '';
    let childCount = 0;
    let currentTargetId = '';
    let currentTargetCode = '';
    let currentTargetName = '';
    let associationName = '';
    let stage = 'association-read';
    let writeOutcomeUncertain = false;
    let uncertainLogged = false;
    let writesAttempted = 0;
    let writesVerified = 0;
    let alreadyInactive = 0;
    let firstMissingObservation = false;
    async function diagnosed(currentStage, operation, context = {}) {
      stage = currentStage;
      try { return await operation(); }
      catch (error) {
        error.stage ||= currentStage;
        for (const [key, value] of Object.entries(context)) if (error[key] == null) error[key] = value;
        throw error;
      }
    }
    if (associationCode) logEvent(logger, 'info', 'reconcile started', { associationId: id, code: associationCode });
    try {
      const association = await diagnosed('association-read', () => client.orgUnit(id), { associationId: id });
      associationCode ||= association?.Code || '';
      associationName = association?.Name || '';
      if (!requestedCode && !existing?.associationCode) logEvent(logger, 'info', 'reconcile started', { associationId: id, code: associationCode });
      if (association?.Type?.Code !== 'Course Offering') throw blocked('wrong-org-unit-type', 'Org unit is not a valid Section Association Course Offering.');
      if (!isAssociation(association)) throw blocked('invalid-association-code', 'Org unit is not a valid Section Association Course Offering.');
      const actualId = String(association.Identifier ?? association.OrgUnitId ?? '');
      if (actualId !== id) throw blocked('unresolved-target', 'Association ID did not match the requested ID.');
      stage = 'children-read';
      const targets = await resolveTargets({ association, client, onValidated: result => { childCount = result.childCount; } });
      const auditBase = { executionId: execution?.executionId, source: execution?.source,
        parentAssociationD2lId: id, parentAssociationOrgCode: association.Code || associationCode || '',
        parentAssociationName: association.Name || '', timestamp: new Date(now()) };

      // Validate every current record and construct every payload before the first write.
      const prepared = [];
      for (const target of targets) {
        currentTargetId = target.id;
        currentTargetCode = target.code; currentTargetName = target.name || '';
        const current = await diagnosed('target-read', () => client.course(target.id), { targetId: target.id, targetCode: target.code });
        currentTargetName ||= current?.Name || '';
        if (current?.IsActive === false) { prepared.push({ target, current, payload: null, status: 'already-inactive' }); alreadyInactive++; }
        else if (current?.IsActive === true) {
          let payload;
          try { payload = courseUpdatePayload(current); }
          catch (error) { error.blocked = true; error.reason = 'invalid-course-offering'; throw error; }
          prepared.push({ target, current, payload, status: dryRun ? 'would-inactivate' : null });
        }
        else throw blocked('unresolved-target', 'Current Course Offering active state is unavailable.');
      }
      logEvent(logger, 'info', 'validation passed', { associationId: id, children: childCount, targets: targets.length });
      const outcomes = [];
      for (const item of prepared) {
        const { target, status: preparedStatus } = item;
        currentTargetId = target.id;
        currentTargetCode = target.code; currentTargetName = target.name || currentTargetName;
        if (preparedStatus) {
          outcomes.push({ ...target, status: preparedStatus });
          if (dryRun) logEvent(logger, 'info', 'dry-run', { associationId: id, targetId: target.id, code: target.code, action: preparedStatus });
          else if (preparedStatus === 'already-inactive') logEvent(logger, 'info', 'target already compliant', { associationId: id, targetId: target.id });
          continue;
        }
        // Re-read immediately before this target's write and build from that current record.
        const latest = await diagnosed('target-read', () => client.course(target.id), { targetId: target.id, targetCode: target.code });
        currentTargetName ||= latest?.Name || '';
        if (latest?.IsActive === false) {
          alreadyInactive++;
          outcomes.push({ ...target, status: 'already-inactive' });
          logEvent(logger, 'info', 'target already compliant', { associationId: id, targetId: target.id });
          continue;
        }
        if (latest?.IsActive !== true) throw blocked('unresolved-target', `Current Course Offering active state is unavailable: ${target.code}`);
        let payload;
        try { payload = courseUpdatePayload(latest); }
        catch (error) { error.blocked = true; error.reason = 'invalid-course-offering'; throw error; }

        logEvent(logger, 'info', 'update starting', { associationId: id, targetId: target.id, code: target.code });
        writeOutcomeUncertain = true;
        writesAttempted++;
        try {
          await diagnosed('target-update', () => client.putCourse(target.id, payload), { targetId: target.id, targetCode: target.code });
        } catch (writeError) {
          // A failed/lost PUT is never repeated here. Resolve its outcome with one read.
          if (writeError.uncertain) {
            logEvent(logger, 'warn', 'uncertain outcome', { associationId: id, targetId: target.id, action: 'read-back-required' });
            uncertainLogged = true;
            const afterUncertain = await diagnosed('verification-read', () => client.course(target.id), { targetId: target.id, targetCode: target.code });
            if (afterUncertain?.IsActive === false) {
              await recordCorrection(recordAudit, { ...auditBase, execution, target, current: latest });
              writeOutcomeUncertain = false;
              uncertainLogged = false;
              outcomes.push({ ...target, status: 'verified-inactive' });
              writesVerified++;
              logEvent(logger, 'info', 'update verified', { associationId: id, targetId: target.id, isActive: false });
              continue;
            }
          }
          if (!writeError.uncertain) writeOutcomeUncertain = false;
          throw writeError;
        }
        const verified = await diagnosed('verification-read', () => client.course(target.id), { targetId: target.id, targetCode: target.code });
        if (verified?.IsActive !== false) {
          writeOutcomeUncertain = false;
          throw Object.assign(new Error(`Course Offering update was not verified: ${target.code}`), { reason: 'verification-failed' });
        }
        await recordCorrection(recordAudit, { ...auditBase, execution, target, current: latest });
        writeOutcomeUncertain = false;
        outcomes.push({ ...target, status: 'verified-inactive' });
        writesVerified++;
        logEvent(logger, 'info', 'update verified', { associationId: id, targetId: target.id, isActive: false });
      }
      const checkedAt = new Date(now());
      const fullyVerified = outcomes.length > 0 && outcomes.every(item => ['already-inactive', 'verified-inactive'].includes(item.status));
      const status = fullyVerified ? 'completed' : 'pending';
      await store.record(id, {
        associationCode: association.Code, lastCheckedAt: checkedAt,
        processedAt: fullyVerified ? checkedAt : null, status, lastError: null,
        ...(fullyVerified ? { lastReconciledAt: checkedAt, lastVerifiedAt: checkedAt,
          reconciliationVersion: RECONCILIATION_VERSION } : {}),
        dryRun, outcomes
      });
      return { status, dryRun, targets: outcomes, writesAttempted, writesVerified, alreadyInactive };
    } catch (error) {
      const status = error.blocked || error.validationFailure ? 'blocked' : 'pending';
      const isInitialAssociation404 = error.stage === 'association-read' && error.status === 404;
      if (isInitialAssociation404) {
        firstMissingObservation = typeof store.recordPotentialMissing === 'function'
          ? await store.recordPotentialMissing(id, new Date(now())) : true;
        if (firstMissingObservation) logEvent(logger, 'warn', 'association missing observed', { associationId: id, code: associationCode });
      }
      if (execution?.executionId && recordAudit && (!isInitialAssociation404 || firstMissingObservation)) {
        try { await recordAudit({ kind: 'exception', executionId: execution.executionId, source: execution.source,
          timestamp: new Date(now()), parentAssociationD2lId: id, parentAssociationOrgCode: associationCode || '',
          parentAssociationName: associationName, affectedCourseOfferingD2lId: currentTargetId || '',
          affectedCourseOfferingOrgCode: currentTargetCode || error.targetCode || '', affectedCourseOfferingName: currentTargetName,
          category: classifyError(error, error.stage || stage),
          explanation: diagnosticExplanation(error, error.stage || stage, id, currentTargetId, currentTargetCode || error.targetCode),
          finalOutcome: status, recordKey: `exception:${id}:${currentTargetId || 'association'}:${error.reason || error.stage || status}` }); }
        catch (auditError) { execution.auditIncomplete = true; logEvent(logger, 'error', 'audit persistence failed', { associationId: id, kind: 'exception' }); }
      }
      if (error.blocked || error.validationFailure) logEvent(logger, 'warn', 'blocked', { associationId: id, code: associationCode, reason: error.reason || 'validation-failed' });
      else if (writeOutcomeUncertain) {
        if (!uncertainLogged) logEvent(logger, 'warn', 'uncertain outcome', { associationId: id, targetId: currentTargetId, action: 'read-back-required' });
        if (error.stage || error.status != null || error.reason) logEvent(logger, 'warn', 'reconcile failed', {
          associationId: id, stage: error.stage || stage, endpoint: error.endpoint, targetId: currentTargetId || undefined,
          httpStatus: error.status, reason: error.reason || 'processing-error' });
      } else logEvent(logger, 'warn', 'reconcile failed', { associationId: id, stage: error.stage || stage,
        endpoint: error.endpoint, targetId: currentTargetId || undefined, httpStatus: error.status,
        reason: error.reason || 'processing-error' });
      await store.record(id, { lastCheckedAt: new Date(now()), status, lastError: safeError(error), processedAt: null });
      return { status, error: safeError(error), writesAttempted, writesVerified, alreadyInactive };
    }
  }
  return { reconcileAssociation };
}

async function recordCorrection(recordAudit, { execution, target, current, ...base }) {
  if (!recordAudit || !base.executionId) return;
  try { await recordAudit({ kind: 'correction', ...base, timestamp: base.timestamp,
    affectedCourseOfferingD2lId: target.id, affectedCourseOfferingOrgCode: target.code,
    affectedCourseOfferingName: target.name || current?.Name || '', previousIsActive: current.IsActive,
    verifiedIsActive: false, result: 'Successfully updated',
    recordKey: `correction:${base.parentAssociationD2lId}:${target.id}` }); }
  catch (error) { if (execution) execution.auditIncomplete = true; throw error; }
}

function hasVerifiedCompletion(record) {
  return record?.status === 'completed' && record.reconciliationVersion === RECONCILIATION_VERSION &&
    record.lastReconciledAt instanceof Date && record.lastVerifiedAt instanceof Date;
}

function blocked(reason, message) { return Object.assign(new Error(message), { blocked: true, reason }); }

function safeError(error) {
  return String(error?.message || 'Reconciliation failed').replace(/https?:\/\/\S+/g, '[URL]')
    .replace(/(authorization|token|secret|private.?key)\s*[:=]\s*[^\s,;]+/ig, '$1=[REDACTED]')
    .replace(/[\r\n\0-\x1f]/g, ' ').slice(0, 240);
}

const STAGE_LABELS = {
  'association-read': 'retrieve association Course Offering',
  'children-read': 'retrieve direct Group children',
  'exact-code-lookup': 'resolve original Course Offering by exact Org Code',
  'target-read': 'retrieve original Course Offering',
  'target-update': 'update original Course Offering',
  'verification-read': 'verify updated Course Offering'
};

function classifyError(error, stage) {
  if (error.validationFailure || error.blocked) return 'validation-blocked';
  if (stage === 'verification-read' || error.reason === 'verification-failed') return 'verification-failed';
  if (stage === 'target-update' || error.uncertain) return 'update-failed';
  if (error.code === 'API_READ_FAILED' || error.code === 'TOKEN_EXCHANGE_FAILED' ||
      ['association-read', 'children-read', 'exact-code-lookup', 'target-read'].includes(stage)) return 'read-failed';
  return 'processing-error';
}

function diagnosticExplanation(error, stage, associationId, targetId, targetCode) {
  const operation = STAGE_LABELS[error.stage || stage] || 'process Section Association';
  const subject = targetCode ? ` ${targetCode}` : targetId ? ` ${targetId}` : ` association ${associationId}`;
  if (Number.isInteger(error.status) && error.status >= 100 && error.status <= 599)
    return `Unable to ${operation}${subject} (HTTP ${error.status}).`;
  if (error.reason === 'api-timeout') return `Unable to ${operation}${subject} (network timeout).`;
  if (error.reason === 'api-network-failed') return `Unable to ${operation}${subject} (network error).`;
  if (error.reason === 'oauth-failed') return `Unable to ${operation}${subject} (OAuth token request failed).`;
  if (error.code === 'API_UPDATE_FAILED') return `Unable to ${operation}${subject} (HTTP status unavailable).`;
  if (error.code === 'API_READ_FAILED') return `Unable to ${operation}${subject} (HTTP status unavailable).`;
  return safeError(error);
}

module.exports = { createReconciler, richTextInput, courseUpdatePayload, RECONCILIATION_VERSION, hasVerifiedCompletion };

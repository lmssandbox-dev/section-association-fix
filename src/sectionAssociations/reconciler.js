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
  async function reconcileAssociation(associationOrgUnitId, { force = false, associationCode: requestedCode } = {}) {
    const id = String(associationOrgUnitId);
    const existing = await store.get(id);
    if (!force && hasVerifiedCompletion(existing)) return { status: 'completed', skipped: true };
    let associationCode = requestedCode || existing?.associationCode || '';
    let childCount = 0;
    let currentTargetId = '';
    let writeOutcomeUncertain = false;
    let uncertainLogged = false;
    let writesAttempted = 0;
    let writesVerified = 0;
    let alreadyInactive = 0;
    if (associationCode) logEvent(logger, 'info', 'reconcile started', { associationId: id, code: associationCode });
    try {
      const association = await client.orgUnit(id);
      associationCode ||= association?.Code || '';
      if (!requestedCode && !existing?.associationCode) logEvent(logger, 'info', 'reconcile started', { associationId: id, code: associationCode });
      if (association?.Type?.Code !== 'Course Offering') throw blocked('wrong-org-unit-type', 'Org unit is not a valid Section Association Course Offering.');
      if (!isAssociation(association)) throw blocked('invalid-association-code', 'Org unit is not a valid Section Association Course Offering.');
      const actualId = String(association.Identifier ?? association.OrgUnitId ?? '');
      if (actualId !== id) throw blocked('unresolved-target', 'Association ID did not match the requested ID.');
      const targets = await resolveTargets({ association, client, onValidated: result => { childCount = result.childCount; } });

      // Validate every current record and construct every payload before the first write.
      const prepared = [];
      for (const target of targets) {
        currentTargetId = target.id;
        const current = await client.course(target.id);
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
        if (preparedStatus) {
          outcomes.push({ ...target, status: preparedStatus });
          if (dryRun) logEvent(logger, 'info', 'dry-run', { associationId: id, targetId: target.id, code: target.code, action: preparedStatus });
          else if (preparedStatus === 'already-inactive') logEvent(logger, 'info', 'target already compliant', { associationId: id, targetId: target.id });
          continue;
        }
        // Re-read immediately before this target's write and build from that current record.
        const latest = await client.course(target.id);
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
          await client.putCourse(target.id, payload);
        } catch (writeError) {
          // A failed/lost PUT is never repeated here. Resolve its outcome with one read.
          if (writeError.uncertain) {
            logEvent(logger, 'warn', 'uncertain outcome', { associationId: id, targetId: target.id, action: 'read-back-required' });
            uncertainLogged = true;
            const afterUncertain = await client.course(target.id);
            if (afterUncertain?.IsActive === false) {
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
        const verified = await client.course(target.id);
        if (verified?.IsActive !== false) {
          writeOutcomeUncertain = false;
          throw Object.assign(new Error(`Course Offering update was not verified: ${target.code}`), { reason: 'verification-failed' });
        }
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
      if (error.blocked || error.validationFailure) logEvent(logger, 'warn', 'blocked', { associationId: id, code: associationCode, reason: error.reason || 'validation-failed' });
      else if (writeOutcomeUncertain) {
        if (!uncertainLogged) logEvent(logger, 'warn', 'uncertain outcome', { associationId: id, targetId: currentTargetId, action: 'read-back-required' });
      } else logEvent(logger, 'warn', 'reconcile failed', { associationId: id, reason: error.reason || 'api-request-failed' });
      await store.record(id, { lastCheckedAt: new Date(now()), status, lastError: safeError(error), processedAt: null });
      return { status, error: safeError(error), writesAttempted, writesVerified, alreadyInactive };
    }
  }
  return { reconcileAssociation };
}

function hasVerifiedCompletion(record) {
  return record?.status === 'completed' && record.reconciliationVersion === RECONCILIATION_VERSION &&
    record.lastReconciledAt instanceof Date && record.lastVerifiedAt instanceof Date;
}

function blocked(reason, message) { return Object.assign(new Error(message), { blocked: true, reason }); }

function safeError(error) {
  return String(error?.message || 'Reconciliation failed').replace(/https?:\/\/\S+/g, '[URL]').replace(/[\r\n\0-\x1f]/g, ' ').slice(0, 240);
}

module.exports = { createReconciler, richTextInput, courseUpdatePayload, RECONCILIATION_VERSION, hasVerifiedCompletion };

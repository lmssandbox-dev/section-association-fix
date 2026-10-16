'use strict';

const { isAssociation } = require('./rules');
const { resolveTargets } = require('./resolver');

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

function createReconciler({ client, store, dryRun = true, now = Date.now }) {
  async function reconcileAssociation(associationOrgUnitId, { force = false } = {}) {
    const id = String(associationOrgUnitId);
    const existing = await store.get(id);
    if (!force && existing?.status === 'completed') return { status: 'completed', skipped: true };
    try {
      const association = await client.orgUnit(id);
      if (!isAssociation(association)) throw Object.assign(new Error('Org unit is not a valid Section Association Course Offering.'), { blocked: true });
      const actualId = String(association.Identifier ?? association.OrgUnitId ?? '');
      if (actualId !== id) throw Object.assign(new Error('Association ID did not match the requested ID.'), { blocked: true });
      const targets = await resolveTargets({ association, client });

      // Validate every current record and construct every payload before the first write.
      const prepared = [];
      for (const target of targets) {
        const current = await client.course(target.id);
        if (current?.IsActive === false) prepared.push({ target, current, payload: null, status: 'already-inactive' });
        else if (current?.IsActive === true) {
          let payload;
          try { payload = courseUpdatePayload(current); }
          catch (error) { error.blocked = true; throw error; }
          prepared.push({ target, current, payload, status: dryRun ? 'would-inactivate' : null });
        }
        else throw Object.assign(new Error(`Current Course Offering active state is unavailable: ${target.code}`), { blocked: true });
      }
      const outcomes = [];
      for (const item of prepared) {
        const { target, status: preparedStatus } = item;
        if (preparedStatus) { outcomes.push({ ...target, status: preparedStatus }); continue; }
        // Re-read immediately before this target's write and build from that current record.
        const latest = await client.course(target.id);
        if (latest?.IsActive === false) { outcomes.push({ ...target, status: 'already-inactive' }); continue; }
        if (latest?.IsActive !== true) throw Object.assign(new Error(`Current Course Offering active state is unavailable: ${target.code}`), { blocked: true });
        let payload;
        try { payload = courseUpdatePayload(latest); }
        catch (error) { error.blocked = true; throw error; }

        try {
          await client.putCourse(target.id, payload);
        } catch (writeError) {
          // A failed/lost PUT is never repeated here. Resolve its outcome with one read.
          if (writeError.uncertain) {
            const afterUncertain = await client.course(target.id);
            if (afterUncertain?.IsActive === false) { outcomes.push({ ...target, status: 'verified-inactive' }); continue; }
          }
          throw writeError;
        }
        const verified = await client.course(target.id);
        if (verified?.IsActive !== false) throw new Error(`Course Offering update was not verified: ${target.code}`);
        outcomes.push({ ...target, status: 'verified-inactive' });
      }
      const status = dryRun ? 'pending' : 'completed';
      const checkedAt = new Date(now());
      await store.record(id, {
        associationCode: association.Code, lastCheckedAt: checkedAt,
        processedAt: dryRun ? null : checkedAt, status, lastError: null,
        dryRun, outcomes
      });
      return { status, dryRun, targets: outcomes };
    } catch (error) {
      const status = error.blocked ? 'blocked' : 'pending';
      await store.record(id, { lastCheckedAt: new Date(now()), status, lastError: safeError(error), processedAt: null });
      return { status, error: safeError(error) };
    }
  }
  return { reconcileAssociation };
}

function safeError(error) {
  return String(error?.message || 'Reconciliation failed').replace(/https?:\/\/\S+/g, '[URL]').replace(/[\r\n\0-\x1f]/g, ' ').slice(0, 240);
}

module.exports = { createReconciler, richTextInput, courseUpdatePayload };

'use strict';

const { originalOfferingCode } = require('./rules');

async function resolveTargets({ association, client, onValidated }) {
  const associationId = String(association.Identifier ?? association.OrgUnitId ?? '');
  const children = await client.children(associationId);
  if (children.length < 2) throw validationError(children.length === 0 ? 'no-children' : 'insufficient-children', 'Association must have at least two direct children.');
  const codes = [];
  for (const child of children) {
    if (child?.Type?.Code !== 'Group') throw validationError('wrong-org-unit-type', 'Every direct child must be a Group.');
    let code;
    try { codes.push(originalOfferingCode(child.Code)); }
    catch (error) { throw validationError('invalid-child-code', error.message, error); }
  }
  if (new Set(codes).size !== codes.length) throw validationError('ambiguous-target', 'Association resolves multiple groups to the same original Course Offering code.');

  const targets = [];
  const targetIds = new Set();
  for (const code of codes) {
    const matches = await client.exactCode(code);
    if (!Array.isArray(matches) || matches.length !== 1) throw validationError(matches?.length > 1 ? 'ambiguous-target' : 'unresolved-target', `Original Course Offering code is missing or ambiguous: ${code}`);
    const match = matches[0];
    const id = String(match.Identifier ?? match.OrgUnitId ?? '');
    if (match?.Type?.Code !== 'Course Offering' || !/^\d+$/.test(id)) throw validationError(match?.Type?.Code !== 'Course Offering' ? 'wrong-org-unit-type' : 'unresolved-target', `Resolved unit is not a valid Course Offering: ${code}`);
    if (id === associationId) throw validationError('unresolved-target', 'An original offering cannot be the association offering itself.');
    if (targetIds.has(id)) throw validationError('ambiguous-target', 'Multiple derived codes resolve to the same original Course Offering.');
    targetIds.add(id);
    targets.push({ id, code, name: match.Name });
  }
  onValidated?.({ childCount: children.length, targetCount: targets.length });
  return targets;
}

function validationError(reason, message, error) {
  const result = error || new Error(message);
  result.reason = reason;
  result.validationFailure = true;
  return result;
}

module.exports = { resolveTargets };

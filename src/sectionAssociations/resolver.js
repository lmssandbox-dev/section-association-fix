'use strict';

const { originalOfferingCode } = require('./rules');

async function resolveTargets({ association, client }) {
  const associationId = String(association.Identifier ?? association.OrgUnitId ?? '');
  const children = await client.children(associationId);
  if (children.length < 2) throw new Error('Association must have at least two direct children.');
  const codes = [];
  for (const child of children) {
    if (child?.Type?.Code !== 'Group') throw new Error('Every direct child must be a Group.');
    const code = originalOfferingCode(child.Code);
    if (!code) throw new Error('Group code does not contain an original Course Offering code.');
    codes.push(code);
  }
  if (new Set(codes).size !== codes.length) throw new Error('Association resolves multiple groups to the same original Course Offering code.');

  const targets = [];
  const targetIds = new Set();
  for (const code of codes) {
    const matches = await client.exactCode(code);
    if (!Array.isArray(matches) || matches.length !== 1) throw new Error(`Original Course Offering code is missing or ambiguous: ${code}`);
    const match = matches[0];
    const id = String(match.Identifier ?? match.OrgUnitId ?? '');
    if (match?.Type?.Code !== 'Course Offering' || !/^\d+$/.test(id)) throw new Error(`Resolved unit is not a valid Course Offering: ${code}`);
    if (id === associationId) throw new Error('An original offering cannot be the association offering itself.');
    if (targetIds.has(id)) throw new Error('Multiple derived codes resolve to the same original Course Offering.');
    targetIds.add(id);
    targets.push({ id, code, name: match.Name });
  }
  return targets;
}

module.exports = { resolveTargets };

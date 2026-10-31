'use strict';

const ASSOCIATION_CODE = /^\d{6}-\d{2}-\d{4}-I0001$/;
const PEOPLE_SOFT_ASSOCIATION_CODE = /^ESPM-(\d{2}0[12])-(.+)$/;
const CHILD_SUFFIX = /-\d{5}$/;

function isAssociationCode(code) {
  if (typeof code !== 'string' || code !== code.trim()) return false;
  const match = PEOPLE_SOFT_ASSOCIATION_CODE.exec(code);
  return ASSOCIATION_CODE.test(code) || Boolean(match && match[2].trim() && !/\s/.test(code));
}

function associationCodeFamily(code) {
  if (typeof code !== 'string') return null;
  if (ASSOCIATION_CODE.test(code)) return { format: 'legacy', period: code.slice(10, 14) };
  const match = PEOPLE_SOFT_ASSOCIATION_CODE.exec(code);
  return match && match[2].trim() && !/\s/.test(code) ? { format: 'peoplesoft', period: match[1] } : null;
}

function isAssociation(record) {
  return record?.Type?.Code === 'Course Offering' && isAssociationCode(record.Code);
}

function originalOfferingCode(childCode) {
  if (typeof childCode !== 'string' || !CHILD_SUFFIX.test(childCode)) {
    throw new Error('Group code must end with a hyphen and exactly five digits.');
  }
  return childCode.slice(0, -6);
}

module.exports = { ASSOCIATION_CODE, PEOPLE_SOFT_ASSOCIATION_CODE, isAssociationCode, associationCodeFamily, isAssociation, originalOfferingCode };

'use strict';

const ASSOCIATION_CODE = /^\d{6}-\d{2}-\d{4}-I0001$/;
const CHILD_SUFFIX = /-\d{5}$/;

function isAssociation(record) {
  return record?.Type?.Code === 'Course Offering' && typeof record.Code === 'string' && ASSOCIATION_CODE.test(record.Code);
}

function originalOfferingCode(childCode) {
  if (typeof childCode !== 'string' || !CHILD_SUFFIX.test(childCode)) {
    throw new Error('Group code must end with a hyphen and exactly five digits.');
  }
  return childCode.slice(0, -6);
}

module.exports = { ASSOCIATION_CODE, isAssociation, originalOfferingCode };

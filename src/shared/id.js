'use strict';

function id(value) {
  if ((typeof value !== 'string' && typeof value !== 'number') ||
      !/^[1-9]\d*$/.test(String(value)) ||
      (typeof value === 'number' && !Number.isSafeInteger(value))) {
    throw new TypeError('Expected a positive decimal Brightspace ID');
  }
  return String(value);
}

module.exports = { id };

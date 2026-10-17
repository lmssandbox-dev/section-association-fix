'use strict';

const { createHash } = require('node:crypto');
const { createConcurrentGate, createConcurrentHttp } = require('./concurrentGate');

function createRateLimitedHttp(options) {
  if (!options?.gate || typeof options.gate.reserve !== 'function' || typeof options.gate.complete !== 'function') {
    throw new Error('Section Association API traffic requires the shared MongoDB rate gate.');
  }
  return createConcurrentHttp({ ...options, seconds });
}

function seconds(value, now) {
  if (value == null) return null;
  const number = Number(value);
  if (Number.isFinite(number) && number >= 0) return number * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

const rateLimitKey = (baseUrl, clientId) => createHash('sha256')
  .update(`${new URL(baseUrl).origin}|${clientId}`).digest('hex');

module.exports = { createRateLimitedHttp, createMongoGate: createConcurrentGate, rateLimitKey, seconds };

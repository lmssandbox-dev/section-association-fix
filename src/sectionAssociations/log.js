'use strict';

const EVENTS = new Set([
  'fast cycle started', 'fast cycle completed', 'fast cycle failed',
  'recovery cycle started', 'recovery cycle completed', 'recovery cycle failed',
  'discovery completed', 'baseline recorded', 'reconcile started',
  'validation passed', 'pending', 'dry-run', 'update starting',
  'update verified', 'target already compliant', 'blocked', 'uncertain outcome',
  'reconcile failed'
]);
const FIELDS = new Set([
  'candidates', 'new', 'alreadyKnown', 'pending', 'completed', 'blocked',
  'associationId', 'targetId', 'code', 'children', 'targets', 'action',
  'isActive', 'reason', 'skipped'
]);

function safeValue(key, value) {
  if (['candidates', 'new', 'alreadyKnown', 'pending', 'completed', 'blocked', 'children', 'targets', 'skipped'].includes(key)) {
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  }
  if (key === 'associationId' || key === 'targetId') return /^\d{1,20}$/.test(String(value)) ? String(value) : null;
  if (key === 'code') return /^\d{6}-\d{2}-\d{4}-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(String(value)) ? String(value) : '[redacted]';
  if (key === 'reason') return /^[a-z0-9-]{1,60}$/.test(String(value)) ? String(value) : 'unknown';
  if (key === 'action') return ['would-inactivate', 'already-inactive', 'read-back-required'].includes(value) ? value : null;
  if (key === 'isActive') return value === false ? 'false' : null;
  return null;
}

function logEvent(logger, level, event, fields = {}) {
  if (!EVENTS.has(event)) return;
  const details = [];
  for (const [key, value] of Object.entries(fields)) {
    if (!FIELDS.has(key)) continue;
    const safe = safeValue(key, value);
    if (safe != null) details.push(`${key}=${safe}`);
  }
  const method = typeof logger?.[level] === 'function' ? logger[level] : logger?.info;
  method?.call(logger, `[section-association] ${event}${details.length ? ` ${details.join(' ')}` : ''}`);
}

module.exports = { logEvent };

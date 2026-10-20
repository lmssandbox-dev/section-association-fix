'use strict';

const EVENTS = new Set([
  'cron started', 'cron completed', 'cron failed', 'cron skipped', 'lease acquired', 'lease released', 'lease unavailable', 'lease release failed', 'recovery due', 'recovery deferred',
  'scheduler started', 'fast cycle started', 'fast cycle completed', 'fast cycle failed', 'fast cycle finished', 'fast cycle skipped',
  'recovery cycle started', 'recovery cycle completed', 'recovery cycle failed', 'recovery cycle finished', 'recovery cycle skipped',
  'discovery completed', 'baseline recorded', 'reconcile started',
  'validation passed', 'pending', 'dry-run', 'update starting',
  'update verified', 'target already compliant', 'blocked', 'uncertain outcome',
  'reconcile failed'
]);
const FIELDS = new Set([
  'candidates', 'discovered', 'new', 'alreadyKnown', 'pending', 'historicalPending', 'completed', 'blocked',
  'dueForReverification', 'processedThisRun', 'remainingHistoricalBacklog', 'writesAttempted', 'writesVerified', 'alreadyInactive',
  'fastIntervalMinutes', 'recoveryIntervalHours',
  'associationId', 'targetId', 'code', 'children', 'targets', 'action',
  'isActive', 'reason', 'skipped', 'phase', 'code', 'protocolCode', 'httpStatus', 'endpoint', 'elapsedMs', 'status', 'fatal', 'due',
  'owner', 'expiresAt', 'acquiredAt', 'leaseKey', 'expired', 'stage'
]);

const PHASES = new Set(['discovery', 'database', 'oauth/api-read', 'oauth', 'reconciliation', 'scheduler']);
const PROTOCOL_CODES = new Set(['invalid_request', 'invalid_client', 'invalid_grant', 'unauthorized_client',
  'unsupported_grant_type', 'invalid_scope', 'server_error', 'temporarily_unavailable']);
const STAGES = new Set(['association-read', 'children-read', 'exact-code-lookup', 'target-read', 'target-update', 'verification-read']);

function safeValue(key, value, event) {
  if (['candidates', 'discovered', 'new', 'alreadyKnown', 'pending', 'historicalPending', 'completed', 'blocked',
    'dueForReverification', 'processedThisRun', 'remainingHistoricalBacklog', 'writesAttempted', 'writesVerified', 'alreadyInactive',
    'children', 'targets', 'skipped', 'fastIntervalMinutes', 'recoveryIntervalHours'].includes(key)) {
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  }
  if (key === 'associationId' || key === 'targetId') return /^\d{1,20}$/.test(String(value)) ? String(value) : null;
  if (key === 'code') {
    const text = String(value);
    if (/^\d{6}-\d{2}-\d{4}-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(text)) return text;
    if (['fast cycle failed', 'recovery cycle failed', 'lease release failed'].includes(event) &&
        /^(?:[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|\d{1,8})$/.test(text)) return text;
    return '[redacted]';
  }
  if (key === 'reason') return /^[a-z0-9-]{1,60}$/.test(String(value)) ? String(value) : 'unknown';
  if (key === 'phase') return PHASES.has(value) ? value : null;
  if (key === 'stage') return STAGES.has(value) ? value : null;
  if (key === 'protocolCode') return PROTOCOL_CODES.has(value) ? value : null;
  if (key === 'httpStatus') return Number.isInteger(value) && value >= 100 && value <= 599 ? String(value) : null;
  if (key === 'elapsedMs') return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  if (key === 'endpoint') return ['association-candidates', 'oauth-token', 'brightspace-api', 'association-detail', 'orgstructure-children', 'exact-org-code', 'course-offering'].includes(value) ? value : null;
  if (key === 'status') return ['completed', 'failed', 'skipped'].includes(value) ? value : null;
  if (key === 'fatal') return typeof value === 'boolean' ? String(value) : null;
  if (key === 'due') return typeof value === 'boolean' ? String(value) : null;
  if (key === 'expired') return typeof value === 'boolean' ? String(value) : null;
  if (key === 'owner') return ['cron', 'unknown'].includes(value) ? value : null;
  if (key === 'leaseKey') return /^cron:[a-f0-9]{64}$/.test(String(value)) ? String(value) : null;
  if (key === 'expiresAt' || key === 'acquiredAt') {
    if (typeof value !== 'string') return null;
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value ? value : null;
  }
  if (key === 'action') return ['would-inactivate', 'already-inactive', 'read-back-required'].includes(value) ? value : null;
  if (key === 'isActive') return value === false ? 'false' : null;
  return null;
}

function safeErrorFields(error, { phase, elapsedMs, endpoint } = {}) {
  const fields = { phase, elapsedMs, endpoint };
  if (typeof error?.code === 'string' || Number.isInteger(error?.code)) fields.code = error.code;
  else if (typeof error?.codeName === 'string') fields.code = error.codeName;
  if (Number.isInteger(error?.status)) fields.httpStatus = error.status;
  else if (Number.isInteger(error?.statusCode)) fields.httpStatus = error.statusCode;
  if (typeof error?.protocolCode === 'string') fields.protocolCode = error.protocolCode;
  if (typeof error?.fatal === 'boolean') fields.fatal = error.fatal;
  return fields;
}

function logEvent(logger, level, event, fields = {}) {
  if (!EVENTS.has(event)) return;
  const details = [];
  for (const [key, value] of Object.entries(fields)) {
    if (!FIELDS.has(key)) continue;
    const safe = safeValue(key, value, event);
    if (safe != null) details.push(`${key}=${safe}`);
  }
  const method = typeof logger?.[level] === 'function' ? logger[level] : logger?.info;
  method?.call(logger, `[section-association] ${event}${details.length ? ` ${details.join(' ')}` : ''}`);
}

module.exports = { logEvent, safeErrorFields };

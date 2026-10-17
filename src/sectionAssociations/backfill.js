'use strict';

const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { isAssociation } = require('./rules');
const { resolveTargets } = require('./resolver');
const { courseUpdatePayload } = require('./reconciler');

const CSV_COLUMNS = ['associationOrgUnitId', 'associationCode', 'baseline', 'associationStatus', 'backfillClassification',
  'blockedReason', 'targetOrgUnitId', 'targetCode', 'currentIsActive', 'plannedAction', 'writeAttempted',
  'verifiedIsActive', 'result', 'errorCode'];
const BLOCKED_REASONS = new Set(['invalid-association-code', 'wrong-org-unit-type', 'unresolved-target', 'no-children',
  'insufficient-children', 'invalid-child-code', 'invalid-child-type', 'ambiguous-target', 'wrong-target-org-unit-type',
  'association-resolving-to-itself', 'incomplete-api-result', 'unexpected-brightspace-response', 'invalid-course-offering']);

function parseBackfillArgs(args = []) {
  let mode = 'dry-run';
  let selectedMode = false;
  let maxAssociations;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run' || args[i] === '--apply') {
      if (selectedMode) throw new Error('Choose exactly one of --dry-run or --apply.');
      selectedMode = true;
      mode = args[i] === '--apply' ? 'apply' : 'dry-run';
    } else if (args[i] === '--max-associations') {
      if (maxAssociations !== undefined) throw new Error('--max-associations may be supplied only once.');
      const value = args[++i];
      if (!/^\d+$/.test(String(value || '')) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
        throw new Error('--max-associations must be a positive whole number.');
      }
      maxAssociations = Number(value);
    } else throw new Error(`Unknown backfill option: ${args[i]}`);
  }
  return { mode, apply: mode === 'apply', maxAssociations: maxAssociations ?? (mode === 'apply' ? 50 : undefined) };
}

function createHistoricalBackfill({ client, store, logger = console, now = Date.now }) {
  async function processAssociation(saved, { apply }) {
    const id = String(saved.associationOrgUnitId);
    const associationCode = saved.associationCode || '';
    let liveCode = associationCode;
    let targets = [];
    let prepared = [];
    let classification;
    let blockedReason = '';
    let errorCode = '';
    try {
      const association = await client.orgUnit(id);
      liveCode = association?.Code || liveCode;
      if (association?.Type?.Code !== 'Course Offering') throw blocked('wrong-org-unit-type');
      if (!isAssociation(association)) throw blocked('invalid-association-code');
      const actualId = String(association.Identifier ?? association.OrgUnitId ?? '');
      if (!/^\d+$/.test(actualId) || actualId !== id) throw blocked('unresolved-target');
      targets = await resolveTargets({ association, client });
      for (const target of targets) {
        const current = await client.course(target.id);
        if (current?.IsActive !== true && current?.IsActive !== false) throw blocked('unexpected-brightspace-response');
        if (current?.Type?.Code && current.Type.Code !== 'Course Offering') throw blocked('wrong-target-org-unit-type');
        if (current.IsActive) {
          try { courseUpdatePayload(current); }
          catch { throw blocked('invalid-course-offering'); }
        }
        prepared.push({ target, current });
      }
      classification = prepared.some(item => item.current.IsActive) ? 'ready' : 'already-compliant';
    } catch (error) {
      classification = 'blocked';
      blockedReason = safeReason(error);
      errorCode = safeCode(error);
      prepared = [];
    }

    const rows = [];
    let writesAttempted = 0;
    let writesVerified = 0;
    let writesFailed = 0;
    let errors = 0;
    for (const item of prepared) {
      const { target } = item;
      const row = { associationOrgUnitId: id, associationCode: liveCode, baseline: true,
        associationStatus: saved.status || '', backfillClassification: classification, blockedReason: '',
        targetOrgUnitId: target.id, targetCode: target.code, currentIsActive: item.current.IsActive,
        plannedAction: item.current.IsActive ? 'inactivate' : 'none', writeAttempted: false,
        verifiedIsActive: item.current.IsActive === false ? false : '',
        result: item.current.IsActive ? (apply ? 'pending' : 'would-inactivate') : 'already-inactive', errorCode: '' };
      rows.push(row);
    }
    if (classification === 'blocked') {
      rows.push({ associationOrgUnitId: id, associationCode: liveCode, baseline: true, associationStatus: saved.status || '',
        backfillClassification: 'blocked', blockedReason, targetOrgUnitId: '', targetCode: '', currentIsActive: '',
        plannedAction: '', writeAttempted: false, verifiedIsActive: '', result: 'blocked', errorCode });
    } else if (apply) {
      for (let i = 0; i < prepared.length; i++) {
        const { target } = prepared[i];
        const row = rows[i];
        if (row.currentIsActive === false) continue;
        try {
          const latest = await client.course(target.id);
          if (latest?.IsActive === false) {
            row.currentIsActive = false;
            row.verifiedIsActive = false;
            row.plannedAction = 'none';
            row.result = 'already-inactive';
            continue;
          }
          if (latest?.IsActive !== true) throw blocked('unexpected-brightspace-response');
          const payload = courseUpdatePayload(latest);
          row.writeAttempted = true;
          writesAttempted++;
          logger.info?.(`[section-association-backfill] write starting associationId=${id} targetId=${target.id} code=${safeLogCode(target.code)}`);
          try {
            await client.putCourse(target.id, payload);
          } catch (writeError) {
            if (!writeError?.uncertain) throw writeError;
            try {
              const readBack = await client.course(target.id);
              if (readBack?.IsActive === false) {
                row.verifiedIsActive = false;
                row.result = 'verified';
                writesVerified++;
                logger.info?.(`[section-association-backfill] write verified associationId=${id} targetId=${target.id}`);
                continue;
              }
            } catch { /* Preserve uncertain outcome for the report and a safe later rerun. */ }
            throw Object.assign(new Error('Uncertain write outcome.'), { code: 'UNCERTAIN_WRITE_OUTCOME' });
          }
          const verified = await client.course(target.id);
          if (verified?.IsActive !== false) throw Object.assign(new Error('Post-write state was not verified.'), { code: 'VERIFICATION_FAILED' });
          row.verifiedIsActive = false;
          row.result = 'verified';
          writesVerified++;
          logger.info?.(`[section-association-backfill] write verified associationId=${id} targetId=${target.id}`);
        } catch (error) {
          row.result = error?.code === 'UNCERTAIN_WRITE_OUTCOME' ? 'uncertain' : row.writeAttempted ? 'write-failed' : 'prewrite-error';
          row.errorCode = safeCode(error);
          errors++;
          if (row.writeAttempted) writesFailed++;
          errorCode = row.errorCode;
          for (const notStarted of rows.slice(i + 1)) if (notStarted.result === 'pending') notStarted.result = 'not-attempted';
          break;
        }
      }
    }

    const activeTargets = prepared.filter(item => item.current.IsActive).length;
    const alreadyInactiveTargets = prepared.length - activeTargets;
    const checkedAt = new Date(now());
    const appliedSuccessfully = apply && classification !== 'blocked' && errors === 0;
    const persistentStatus = classification === 'blocked' ? 'blocked' : appliedSuccessfully ? 'completed' : errors ? 'pending' : classification;
    const targetMetadata = rows.filter(row => row.targetOrgUnitId).map(row => ({ targetOrgUnitId: row.targetOrgUnitId,
      targetCode: row.targetCode, result: row.result, verifiedIsActive: row.verifiedIsActive === '' ? null : row.verifiedIsActive,
      errorCode: row.errorCode || null }));
    const metadata = { backfillLastCheckedAt: checkedAt,
      backfillStatus: errors ? 'pending' : persistentStatus,
      backfillLastError: blockedReason || errorCode || null, backfillTargets: targetMetadata };
    if (apply) metadata.backfillProcessedAt = appliedSuccessfully ? checkedAt : null;
    const persisted = await store.recordBackfill(id, metadata);
    if (!persisted) throw Object.assign(new Error('Baseline record disappeared during backfill.'), { code: 'BACKFILL_RECORD_LOST' });

    return { rows, classification, blockedReason, targetsFound: targets.length, activeTargets,
      alreadyInactiveTargets, writesAttempted, writesVerified, writesFailed, errors };
  }

  async function run({ apply = false, maxAssociations } = {}) {
    const summary = { associationsScanned: 0, ready: 0, alreadyCompliant: 0, blocked: 0,
      targetsFound: 0, activeTargets: 0, alreadyInactiveTargets: 0, writesAttempted: 0, writesVerified: 0, writesFailed: 0 };
    const rows = [];
    summary.errors = 0;
    logger.info?.(`[section-association-backfill] run started mode=${apply ? 'apply' : 'dry-run'} maxAssociations=${maxAssociations ?? 'all'}`);
    const baseline = await store.baselineStatus();
    if (baseline?.state !== 'ready') throw new Error('Historical backfill requires a completed MongoDB baseline.');
    const records = await store.listBaselineAssociations(maxAssociations);
    for (const record of records) {
      const result = await processAssociation(record, { apply });
      summary.associationsScanned++;
      summary[result.classification === 'already-compliant' ? 'alreadyCompliant' : result.classification]++;
      for (const key of ['targetsFound', 'activeTargets', 'alreadyInactiveTargets', 'writesAttempted', 'writesVerified', 'writesFailed']) summary[key] += result[key];
      summary.errors += result.errors;
      rows.push(...result.rows);
      if (result.classification === 'blocked') logger.warn?.(`[section-association-backfill] association blocked associationId=${record.associationOrgUnitId} reason=${result.blockedReason}`);
      else logger.info?.(`[section-association-backfill] association ${result.classification === 'already-compliant' ? 'already-compliant' : 'ready'} associationId=${record.associationOrgUnitId} code=${safeLogCode(record.associationCode)} targets=${result.targetsFound} activeTargets=${result.activeTargets}`);
      for (const row of result.rows) if (row.result === 'would-inactivate') {
        logger.info?.(`[section-association-backfill] target associationId=${row.associationOrgUnitId} targetId=${row.targetOrgUnitId} code=${safeLogCode(row.targetCode)} currentIsActive=true action=would-inactivate`);
      } else if (row.result === 'already-inactive') {
        logger.info?.(`[section-association-backfill] target associationId=${row.associationOrgUnitId} targetId=${row.targetOrgUnitId} code=${safeLogCode(row.targetCode)} currentIsActive=false action=already-inactive`);
      }
    }
    logger.info?.(`[section-association-backfill] run summary associationsScanned=${summary.associationsScanned} ready=${summary.ready} alreadyCompliant=${summary.alreadyCompliant} blocked=${summary.blocked} targetsFound=${summary.targetsFound} activeTargets=${summary.activeTargets} alreadyInactiveTargets=${summary.alreadyInactiveTargets} writesAttempted=${summary.writesAttempted} writesVerified=${summary.writesVerified} writesFailed=${summary.writesFailed} errors=${summary.errors}`);
    return { rows, summary };
  }

  return { run };
}

async function writeCsvReport({ rows, outputDir = 'reports', now = Date.now, runId = randomUUID() }) {
  const timestamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
  const file = path.resolve(outputDir, `section-association-backfill-${timestamp}-${runId}.csv`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const lines = [CSV_COLUMNS.map(csv).join(','), ...rows.map(row => CSV_COLUMNS.map(key => csv(row[key])).join(','))];
  await fs.writeFile(file, `${lines.join('\r\n')}\r\n`, 'utf8');
  return file;
}

function csv(value) {
  if (value === null || value === undefined) return '""';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function blocked(reason) { return Object.assign(new Error('Historical association validation failed.'), { reason, validationFailure: true }); }
function safeReason(error) {
  if (error?.message === 'An original offering cannot be the association offering itself.') return 'association-resolving-to-itself';
  if (error?.reason === 'wrong-org-unit-type' && error?.message === 'Every direct child must be a Group.') return 'invalid-child-type';
  if (error?.reason === 'wrong-org-unit-type' && String(error?.message || '').startsWith('Resolved unit is not a valid Course Offering:')) return 'wrong-target-org-unit-type';
  const reason = error?.reason || 'unexpected-brightspace-response';
  return BLOCKED_REASONS.has(reason) ? reason : 'unexpected-brightspace-response';
}
function safeCode(error) {
  if (error?.validationFailure && error?.code == null) return 'VALIDATION_FAILED';
  const value = error?.code ?? error?.status;
  return /^(?:[A-Z][A-Z0-9_]{0,63}|[1-5]\d\d)$/.test(String(value || '')) ? String(value) : 'BACKFILL_ERROR';
}
function safeLogCode(value) { return /^[A-Za-z0-9-]{1,100}$/.test(String(value || '')) ? String(value) : '[redacted]'; }

module.exports = { CSV_COLUMNS, parseBackfillArgs, createHistoricalBackfill, writeCsvReport };

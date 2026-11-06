'use strict';

const { runSectionAssociationCron } = require('./cron');

function createManualExecutionController({ service, store, recoveryIntervalHours, maxReconciliationsPerRun,
  apiHealthService, logger = console, run = runSectionAssociationCron, setIntervalFn = setInterval,
  clearIntervalFn = clearInterval }) {
  let polling = null;
  let dispatching = false;

  async function dispatch(requestId) {
    if (dispatching) return;
    dispatching = true;
    try {
      await run({ service, store, recoveryIntervalHours, maxReconciliationsPerRun,
        apiHealthService, logger, source: 'manual', manualRequestId: requestId });
    } catch {
      try { await store.finishManualExecution(requestId, 'failed', 'MANUAL_EXECUTION_FAILED'); }
      catch { logger.warn?.('[section-association] manual request recovery deferred'); }
    } finally { dispatching = false; }
  }

  async function request(requester) {
    const result = await store.requestManualExecution(requester);
    if (result.accepted) void dispatch(result.requestId);
    return result;
  }

  async function recoverPending() {
    if (dispatching) return;
    try {
      const pending = await store.getManualExecutionRequest();
      if (['requested', 'running'].includes(pending?.status)) void dispatch(pending.requestId);
    } catch { logger.warn?.('[section-association] manual request recovery lookup failed'); }
  }

  function startRecoveryPolling(intervalMs = 30000) {
    if (!polling) {
      polling = setIntervalFn(recoverPending, intervalMs);
      void recoverPending();
    }
    return polling;
  }
  function stopRecoveryPolling() { if (polling) clearIntervalFn(polling); polling = null; }

  return { request, getStatus: () => (store.getManualExecutionStatus || store.getManualExecutionRequest).call(store), recoverPending,
    startRecoveryPolling, stopRecoveryPolling };
}

module.exports = { createManualExecutionController };

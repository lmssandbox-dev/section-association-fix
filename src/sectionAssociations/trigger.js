'use strict';

const { startSectionAssociationScheduler } = require('./scheduler');

function startSectionAssociationTrigger({ mode, service, store, fastIntervalMinutes, recoveryIntervalHours, logger = console,
  scheduler = startSectionAssociationScheduler }) {
  if (mode === 'cron') {
    logger.log?.('[section-association] trigger mode=cron internal scheduler disabled');
    return null;
  }
  if (mode !== 'internal') throw new Error('SECTION_ASSOCIATION_FIX_TRIGGER_MODE must be either cron or internal.');
  logger.log?.('[section-association] trigger mode=internal');
  return scheduler({ service, store, fastIntervalMinutes, recoveryIntervalHours });
}

module.exports = { startSectionAssociationTrigger };

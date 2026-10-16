'use strict';

// Read-only live acceptance runner. Uses the same OAuth and API clients as the
// app; it neither starts ltijs/MongoDB nor prints raw API responses or secrets.
const { id } = require('../src/shared/id');
const { assessDiscovery } = require('./discovery-acceptance');
const { createBrightspaceAuth } = require('../src/shared/auth');
const { createBrightspaceClient, createBrightspaceGet } = require('../src/shared/client');
const { createAssignmentsClient } = require('../src/dates/activities/assignments');
const { createQuizzesClient } = require('../src/dates/activities/quizzes');
const { createDiscussionsClient } = require('../src/dates/activities/discussions');
const { createActivityDiscovery } = require('../src/dates/activityDiscovery');

async function main() {
  if (process.argv.length < 3) throw new Error('usage');
  const offeringIds = [...new Set(process.argv.slice(2).map(id))];
  require('dotenv').config();
  const http = require('axios');
  const env = process.env;
  const required = ['BS_URL', 'D2L_LE_VERSION', 'D2L_OAUTH2_CLIENT_ID',
    'D2L_OAUTH2_PRIVATE_KEY', 'D2L_OAUTH2_KEY_ID', 'D2L_OAUTH2_SCOPES'];
  if (required.some(key => !env[key] || /replace|placeholder|your-tenant/i.test(env[key]))) throw new Error('configuration required');
  const oauth = createBrightspaceAuth({ http, clientId: env.D2L_OAUTH2_CLIENT_ID,
    scope: env.D2L_OAUTH2_SCOPES, kid: env.D2L_OAUTH2_KEY_ID,
    privateKeyPem: env.D2L_OAUTH2_PRIVATE_KEY, tokenEndpoint: env.D2L_OAUTH2_TOKEN_ENDPOINT });
  const api = createBrightspaceClient({
    get: createBrightspaceGet({ http, oauth, baseUrl: env.BS_URL }),
    leRoot: `${env.BS_URL}/d2l/api/le/${env.D2L_LE_VERSION}`
  });
  const discovery = createActivityDiscovery({ assignments: createAssignmentsClient(api),
    quizzes: createQuizzesClient(api), discussions: createDiscussionsClient(api) });
  for (const orgUnitId of offeringIds) {
    try {
      const result = await discovery.discover(orgUnitId);
      const assessment = assessDiscovery(result);
      if (!assessment.passed) process.exitCode = 1;
      console.log(JSON.stringify({ orgUnitId, status: assessment.passed ? 'passed' : 'incomplete',
        checks: assessment.checks, counts: result.counts,
        warnings: result.warnings }, null, 2));
    } catch {
      console.log(JSON.stringify({ orgUnitId, status: 'failed',
        error: 'Discovery or canonical-identity check failed. Check versions, permissions, scopes and diagnostic output.' }));
      process.exitCode = 1;
    }
  }
}

main().catch(() => {
  console.error('Live verification could not start. Use: npm run verify:discovery -- <offeringOrgUnitId> [moreOfferingIds...], with installed dependencies and configured OAuth environment.');
  process.exitCode = 1;
});

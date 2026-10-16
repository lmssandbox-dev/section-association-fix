'use strict';
// Single-activity operator tool; preview by default, explicit --apply to write.
const { id } = require('../src/shared/id');
const { createBrightspaceAuth } = require('../src/shared/auth');
const { createBrightspaceClient, createBrightspaceGet, createActivityPut, hasScope } = require('../src/shared/client');
const { createActivityWriter, validateDates } = require('../src/dates/activityWriters');
const scopes = { assignment: 'dropbox:folders:write', quiz: 'quizzing:quizzes:write', discussionTopic: 'discussions:topics:manage' };
function parseArgs(args) {
  args = [...args];
  const apply = args.at(-1) === '--apply';
  if (apply) args.pop();
  const [type, courseId, activityId, start, due, end, forumId] = args;
  if (!Object.hasOwn(scopes, type) || args.length !== (type === 'discussionTopic' ? 7 : 6)) throw new Error('usage');
  return { orgUnitId: id(courseId), activity: { type, id: id(activityId),
    ...(type === 'discussionTopic' ? { parentId: id(forumId) } : {}) },
    dates: validateDates({ start, due, end }), dryRun: !apply };
}
async function main() {
  const request = parseArgs(process.argv.slice(2));
  require('dotenv').config();
  const http = require('axios'), env = process.env, type = request.activity.type;
  const leRoot = `${env.BS_URL}/d2l/api/le/${env.D2L_LE_VERSION}`;
  if (!request.dryRun && !hasScope(env.D2L_OAUTH2_SCOPES, scopes[type])) throw new Error('scope');
  const oauth = createBrightspaceAuth({ http, clientId: env.D2L_OAUTH2_CLIENT_ID, scope: env.D2L_OAUTH2_SCOPES,
    kid: env.D2L_OAUTH2_KEY_ID, privateKeyPem: env.D2L_OAUTH2_PRIVATE_KEY, tokenEndpoint: env.D2L_OAUTH2_TOKEN_ENDPOINT });
  const api = createBrightspaceClient({ leRoot, get: createBrightspaceGet({ http, oauth, baseUrl: env.BS_URL }) });
  const writer = createActivityWriter({ api, type, put: createActivityPut({ http, oauth, leRoot, type }) });
  const result = await writer.updateActivityDates(request);
  console.log(JSON.stringify(result, null, 2));
  if (result.status === 'failed') process.exitCode = 1;
}
if (require.main === module) main().catch(() => {
  console.error('Could not start. Use npm run activity:dates -- <assignment|quiz|discussionTopic> <courseId> <activityId> <startISO> <dueISO> <endISO> [forumId for discussionTopic] [--apply]. Configure OAuth and the matching write scope for --apply. Without --apply this is a dry run.');
  process.exitCode = 1;
});
module.exports = { parseArgs };

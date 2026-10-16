# Brightspace Section Association cleanup

This service detects Course Offerings created by IPSIS Section Association processing and inactivates the original standalone Course Offerings represented by their grouped sections. It does not rename or delete anything, move groups, or change enrollments or mappings.

## How it works

The worker searches `GET /d2l/api/lp/{version}/orgstructure/?orgUnitType=3&orgUnitCode=I0001`, follows all bookmark pages, and filters results using `^\\d{6}-\\d{2}-\\d{4}-I0001$`. For each eligible association, it reads all direct children. Each must be a Group whose code ends in `-` and exactly five digits. Removing that suffix produces the original Course Offering code, which must resolve through exact-code search to exactly one Course Offering.

The worker validates the complete set before writing. It then checks each current Course Offering. Active records are updated with a full PUT payload built from the immediately preceding GET, changing only `IsActive` to `false`; the result is read back and verified. Brightspace RichText Description values are converted to the RichTextInput format expected by PUT.

## Safety and rollout

`SECTION_ASSOCIATION_FIX_DRY_RUN=true` is the default. Dry-run discovers, resolves, validates, and reports `would-inactivate` outcomes without sending PUT requests. It shares the production reconciler and remains pending so the same association can be processed after dry-run is disabled.

On the first successful discovery, the service records the associations already present as a baseline and does not reconcile any of them. Historical cleanup is intentionally outside this service. Associations first seen after baseline wait ten minutes before processing.

The fast loop discovers every 15 minutes and handles stable new associations. The recovery loop runs every four hours and retries incomplete work through the same discovery/reconciliation logic. Completed associations are skipped during ordinary runs. MongoDB records last-seen/check times and outcomes; Brightspace remains the source of truth.

## Authentication

Background calls use Brightspace Server-to-Server OAuth 2.0 client credentials with a signed private-key JWT. LTI 1.3 registration is optional at startup; no worker action depends on an LTI user session.

The service account needs OAuth scopes `organizations:organization:read` and `orgunits:course:update`, plus Brightspace organizational-structure read access and Manage Courses permission to update Course Offerings. These scopes must be granted to the OAuth application and listed in `BS_OAUTH2_SCOPES`.

## Hosting / Trigger Modes

`SECTION_ASSOCIATION_FIX_TRIGGER_MODE=cron` is the default for Render Free and other sleeping web services. The web service hosts LTI and bootstrap endpoints without in-process recurring timers. Configure one Render Cron Job from this repository on `*/15 * * * *` with command `npm run cron:section-association`. Every run performs one fast cycle and uses persisted Mongo metadata to run recovery only when the four-hour interval is due.

Set `SECTION_ASSOCIATION_FIX_TRIGGER_MODE=internal` for future always-on hosting. The web process then starts an immediate fast cycle and the existing independent recurring fast and recovery timers; no external Cron Job is required. Both modes use the same service and reconciliation engine.

To migrate cron → always-on: upgrade the web service, set trigger mode to `internal`, disable/delete the Cron Job, deploy, and confirm the internal-mode startup, immediate cycle, next fast cycle, and recovery timing. Keep the same Mongo state, baseline, OAuth credentials, Service User, and reconciliation engine. To migrate always-on → cron: set mode to `cron`, deploy, enable one external Cron Job at the schedule above, and keep the same Mongo/OAuth configuration and association state.

## LTI bootstrap

Deploy first with the `BS_LTI_*` settings empty. The service starts in LTI setup mode, runs the Section Association worker, and serves `/ping` and `/.well-known/brightspace-jwks.json`. Register the tool in Brightspace using the public application keyset URL `https://<your-render-service>.onrender.com/.well-known/brightspace-jwks.json` (or the equivalent URL on your configured public domain). After Brightspace returns the LTI Client ID and Deployment ID, configure all five `BS_LTI_*` values and redeploy. The next startup registers the Brightspace platform and enables LTI launches. Partial LTI configuration is treated as setup mode.

## Run

Use Node.js 22, install with `npm ci`, copy `.env.example` to `.env`, and provide tenant credentials. Run `npm test` and `npm run check`; start with `npm start`. Keep dry-run enabled until logs confirm the expected targets. Set `SECTION_ASSOCIATION_FIX_DRY_RUN=false` only when ready to permit inactivation.

See [ENVIRONMENT.md](ENVIRONMENT.md) for configuration and [TECHNICAL.md](TECHNICAL.md) for reconciliation and persistence details.

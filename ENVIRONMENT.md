# Environment configuration

Configure these values in `.env` for local use and in the service host for deployment. Never commit credentials.

## Required application settings

| Setting | Purpose |
| --- | --- |
| `DB_MONGODB_URL` | MongoDB connection URI with an explicit application database name. |
| `APP_LTI_SECRET` | Application-internal secret used by ltijs; not a Brightspace LTI registration credential. |
| `PORT` | HTTP port; defaults to `3000`. |
| `BS_URL` | Brightspace HTTPS origin. |
| `BS_NAME` | Optional Brightspace display name. |
| `BS_OAUTH2_CLIENT_ID` | OAuth application/service-account client ID. |
| `BS_OAUTH2_PRIVATE_KEY` | RSA private key PEM used for signed JWT client authentication. |
| `BS_OAUTH2_KEY_ID` | Key ID registered for that private key. |
| `BS_OAUTH2_TOKEN_ENDPOINT` | OAuth token endpoint. |
| `BS_OAUTH2_SCOPES` | Must include `organizations:organization:read` and `orgunits:course:update`. |
| `D2L_API_LP_VERSION` | Brightspace Learning Platform API version in `major.minor` form. |
| `SECTION_ASSOCIATION_FIX_TRIGGER_MODE` | `cron` by default; use `internal` only on always-on hosting. |

The background worker uses the OAuth service account and does not require an LTI launch or LTI registration configuration.

## Optional LTI registration

All five settings below must be present to register the Brightspace platform and enable LTI launches. If none or only some are present, the service starts in setup mode, skips platform registration, and continues serving `/ping`, the public JWKS endpoint, and the Section Association worker.

| Setting | Purpose |
| --- | --- |
| `BS_LTI_CLIENT_ID` | Client ID returned by Brightspace during tool registration. |
| `BS_LTI_DEPLOYMENT_ID` | Deployment ID returned by Brightspace. |
| `BS_LTI_AUTH_ENDPOINT` | Brightspace platform OIDC authorization endpoint. |
| `BS_LTI_TOKEN_ENDPOINT` | Brightspace platform access-token endpoint. |
| `BS_LTI_KEYSET_URL` | Brightspace platform keyset URL used to validate platform requests. |

Bootstrap sequence: deploy with the `BS_LTI_*` settings empty; register the tool in Brightspace using the public application keyset URL `https://<your-render-service>.onrender.com/.well-known/brightspace-jwks.json`; add the returned LTI Client ID and Deployment ID with all platform endpoints; redeploy. The application's public JWKS URL is distinct from `BS_LTI_KEYSET_URL`, which points to Brightspace's keyset.

After configuration, an LTI launch opens the compact monitor with grouped service/worker status, bold discovery period codes or “All periods”, a concise latest-execution line, and the latest 50 automatic/manual executions. History labels its second column `Periods / Scope`: rows show the scope recorded for that run, `Mixed` when discovery ran with other activities, or `Historical`/`Re-verification` for activity-only runs. Missing or old metadata appears as `—`. Expanded details avoid repeating scope already shown in the row. The latest Source field is omitted from the page; source remains in persisted summaries and the existing history CSV. The page offers administrator-only Run Now, Refresh, Export History CSV, and per-execution audit reports when available. Mongo stores one idempotently upserted history document per execution in the existing tenant-scoped `section_association_meta` collection, including optional `discoveryPeriods` and `discoveryActivities` metadata captured from actual worker results. There is no count-based history limit or TTL; MongoDB storage capacity and operator retention policies apply. Store initialization creates the `{ namespace: 1, history: 1, startedAt: -1, executionId: -1 }` history index; no migration is required. The CSV endpoint streams all retained summaries on demand. Existing columns and contents remain unchanged. Missing values remain blank, and no CSV file is retained. Both the status and CSV endpoints require the active verified LTI session and matching deployment ID. Automatic and manual runs must share the Mongo database and tenant/OAuth client namespace.

The Service Status heading also has an **API Health Check** button that opens a view in the current LTI page. It shows the configured LP version, latest tenant-supported version, version health, endpoint risk counts, the latest successful timestamp, and freshness. Expand **Endpoint Details** for the six logical LP operations and D2L links. **Run Check** uses the existing service-account OAuth credentials and shared API rate limiter. Opening the view and refreshing the dashboard use cached MongoDB results only.

API Health Check does not add environment variables or a scheduled job. The existing cron invocation starts an assessment once daily after 02:00 Sao Paulo time and after reconciliation history is saved; internal mode checks after its existing fast cycle. Both use tenant-scoped Mongo coordination. Manual checks share that coordination and have a five-minute cooldown. Mongo retains the latest successful result, the last attempt/failure, and up to 30 successful assessments. Results are current for 36 hours; older results, inventory-revision mismatches, or a failed latest attempt report current health as **Unknown**, while retaining previous successful evidence. D2L lifecycle evidence is a dated local inventory, not a live documentation lookup. Version support is checked separately from contract verification. The check uses only version-query diagnostics, including Brightspace's native version-check POST; it never performs Course Offering updates. LTI routes require the verified session and configured deployment. The manual POST additionally validates same-origin browser request headers.

Current inventory lifecycle evidence was verified 2026-10-19 against the official D2L developer reference. It records LP 1.49 as the minimum for Org Unit and Course Offering route availability, and LP 1.59 as the minimum for the Course Offering update behavior that requires `IsActive`. OAuth token exchange is recorded separately as an authentication diagnostic. Endpoint contract verification remains **Not Verified** because runtime tenant version support does not exercise application payload contracts. Update the inventory, tests, and docs whenever API usage changes.

## Service-account permissions

For the Server-to-Server Service User Client Credentials flow, the signed assertion `aud` must exactly match `BS_OAUTH2_TOKEN_ENDPOINT`; the standard endpoint is `https://auth.brightspace.com/core/connect/token`. This differs from the LTI Advantage service-token audience. The public JWKS endpoint publishes the matching public key, never the private key.

The OAuth application needs the two scopes above. Its linked Brightspace Service User needs permission to read organizational structure and Manage Courses permission to update Course Offerings.

## Section Association settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `SECTION_ASSOCIATION_FIX_DRY_RUN` | `true` | Resolve and report intended inactivations without PUT requests. |
| `SECTION_ASSOCIATION_FIX_FAST_INTERVAL_MINUTES` | `15` | Fast discovery/reconciliation cadence. |
| `SECTION_ASSOCIATION_FIX_STABILITY_MINUTES` | `10` | Minimum age for newly discovered associations. Historical records do not wait. |
| `SECTION_ASSOCIATION_FIX_RECOVERY_INTERVAL_HOURS` | `4` | Independent recovery cadence for pending and blocked retry work. |
| `SECTION_ASSOCIATION_FIX_MAX_RECONCILIATIONS_PER_RUN` | `50` | Maximum associations processed by a scheduled run. |
| `SECTION_ASSOCIATION_FIX_CHILD_MONITOR_BATCH_SIZE` | `125` | Maximum completed-association child inspections per run during 07:00–23:00. |
| `SECTION_ASSOCIATION_FIX_STATUS_VERIFY_BATCH_SIZE` | `150` | Maximum cached-ID status verifications per eligible run during 01:00–07:00, at :00 and :30 only. |
| `SECTION_ASSOCIATION_DEBUG_ID` | Unset | Temporary, targeted child-monitoring diagnostics for one numeric association ID. Remove it after troubleshooting. |
| `SECTION_ASSOCIATION_DISCOVERY_PERIODS` | Unset (`auto`) | Regular discovery scope. See supported values below; invalid values fail startup. |

The single Render cron remains on `*/15 * * * *` 24/7. In São Paulo time, configured period discovery and child monitoring run 07:00–23:00; broad historical discovery runs 23:00–01:00 once per nightly window after success; cached-ID status checks run every 30 minutes from 01:00 through 06:30 (window 01:00–07:00); pending and blocked recovery remains eligible all day. `SECTION_ASSOCIATION_DISCOVERY_PERIODS` controls regular discovery. An undefined variable, an explicitly empty value, or `auto` selects previous/current/next. `all` selects daily broad discovery; ongoing monitoring remains limited to previous/current/next even with explicit older or additional periods.

For temporary troubleshooting, set `SECTION_ASSOCIATION_DEBUG_ID` to one numeric association ID, such as `36183`. Only that association's child-monitoring diagnostic is logged, and only when it is selected during normal monitoring. The diagnostic reuses the existing MongoDB record and Brightspace child response; it adds no reads and changes no monitoring behavior. It reports saved/current child IDs and Org Codes, child types, mapping validation, comparison result, reconciliation reason/capacity outcome, and successful-inspection timestamp outcome. Remove the setting after troubleshooting; it is unset by default.

| Value | Regular discovery behavior |
| --- | --- |
| Undefined (remove the variable) | Automatic previous, current, and next periods. |
| `auto` | Same automatic behavior. |
| `2601,2602,2701` | Search exactly those periods. |
| `2701` | Search only `2701`. |
| `all` | Use broad historical discovery once per daily window; ongoing monitoring remains previous/current/next. |
| Explicit empty string | Same automatic behavior as unset or `auto`. |

Automatic periods use `America/Sao_Paulo`: `YY01` covers January–June and `YY02` covers July–December. October 2026 resolves to `2601`, `2602`, and `2701`. Values are trimmed, explicit values are deduplicated, and periods must match `YY01` or `YY02`; keywords are case-insensitive. Invalid values stop startup. In Render, configure automatic discovery by removing this variable, leaving it empty, or setting it to `auto`; configure all-period discovery by setting it to `all`. No academic-period rollover setting is needed. The `FAST_INTERVAL_MINUTES` setting controls internal-mode fast timers; the deployed Render Cron Job remains on `*/15 * * * *`.

## Hosting / Trigger Modes

### Cron mode (default)

Use `SECTION_ASSOCIATION_FIX_TRIGGER_MODE=cron` for sleeping hosting. Configure one Render Cron Job:

- Schedule: `*/15 * * * *`
- Command: `npm run cron:section-association`

Since the October 30, 2026 PeopleSoft transition, each configured period is searched with two `orgUnitCode` substring values: `{period}-I0001` for legacy codes and `ESPM-{period}-` for new codes such as `ESPM-2602-GS2-C0011`. Session and sequence pieces vary and are not configuration values. Automatic scope searches previous/current/next; explicit lists search only their listed periods. The initial baseline and daily historical scan run in the 23:00–01:00 São Paulo window once per logical nightly window; the same window key spans midnight so success before 00:00 suppresses a duplicate after midnight using broad `I0001` and `ESPM-` searches. The successful full scan is recorded in tenant-scoped `section_association_meta` only after both queries and persistence succeed. A failed/partial scan leaves it due and retries on later cron invocations in the same window. `all` uses the broad pair once daily. Period configuration only selects existing Brightspace offerings to search; it cannot create an offering or recover an IPSIS import that failed.

Missing confirmation is isolated by code family and period. A legacy query can only confirm absence for legacy records in that period, and an `ESPM-` query only for PeopleSoft records. Broad discovery is likewise family-specific. Both require a completed successful query, exact Org Unit ID absence, and the existing 30-minute observation delay; partial or failed searches do not establish absence. Existing Mongo records remain compatible without migration.

Successful full reconciliation saves versioned direct-child and original-offering mappings plus separate child and status success timestamps on each `section_associations` record. Legacy records without mappings stay compatible and are sent through full reconciliation before optimized checks. Child checks compare ID/code snapshots during 07:00–23:00; nighttime checks GET cached original IDs during 01:00–07:00. A changed or untrusted result triggers the existing full reconciler after fresh association/child/exact-code validation; cached IDs never authorize a PUT. A fully completed dry run that confirms every target is already inactive also saves its verified mapping snapshot; a dry run with active targets remains pending and does not claim a completed mapping. Failed or incomplete reconciliations do not overwrite successful snapshots. Child/status budgets default to 125/150 checks per eligible run; cached-ID verification runs only at :00 and :30 from 01:00 through 06:30 (the Render cron still starts every 15 minutes), and all reads share the Brightspace limiter; backlog continues in oldest-successful-check order, and recent failures back off for an hour. Pending and blocked work remains eligible around the clock. Full reconciliation remains capped at 50 per cron invocation across fast and recovery work. All phases share the existing lease and execution; no second Render job is needed.

Cron and worker processing share an atomic namespaced Mongo lease, renewed while running and explicitly awaited on release. Expiry is crash protection. Inspect without modifying state with `npm run section-association:lease-status`.

The LTI dashboard **Run Now** action works in either trigger mode and needs no additional environment variable or Render service. It is available only when the validated LTI roles claim explicitly identifies an Administrator or SysAdmin. The route records one durable tenant-scoped request, returns immediately, and dispatches through the existing shared lease and reconciliation controller. If a worker already owns the lease, the request remains requested and recovery retries it; running is reported only after lease acquisition. The web process polls every 30 seconds, and cron/internal workers also recover pending or interrupted requests. Dry-run, time-window eligibility, API throttling, and the 50-reconciliation cap still apply.

### Internal mode

Use `SECTION_ASSOCIATION_FIX_TRIGGER_MODE=internal` only on always-on hosting. The web process runs an immediate cycle followed by configured fast and recovery timers. It uses the same namespaced Mongo lease and maintenance windows. Do not enable the external Render Cron Job while internal timers are active.

### Trigger migration

Cron → always-on: upgrade the web service, set mode to `internal`, disable/delete the Cron Job, deploy, and confirm cycles. Always-on → cron: set mode to `cron`, deploy, then enable one external Cron Job. Keep Mongo state, credentials, baseline metadata, and the same reconciliation engine.

## Unified historical and new processing

Historical baseline associations are included by the normal worker and use the same reconciliation, validation, dry-run, and apply behavior as new work. The baseline marker remains audit metadata. Each run is capped by `SECTION_ASSOCIATION_FIX_MAX_RECONCILIATIONS_PER_RUN`; new and pending records are prioritized, historical records follow, and blocked retries are handled by recovery. Completed records use daytime child inspection and nighttime cached-ID status checks, not routine full re-verification. Legacy completed records without mappings are sent through full reconciliation to create a verified snapshot.

Dry-run sends zero PUTs. A record with any active target remains pending so it can be processed when dry-run is disabled. Live updates only inactivate active targets and verify each write. Already-inactive targets are no-ops. Review operational logs and Mongo reports/state as appropriate; there is no rollback implementation.

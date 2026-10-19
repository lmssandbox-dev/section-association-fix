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

After configuration, an LTI launch opens the compact read-only monitor with grouped service/worker status, bold discovery period codes or “All periods”, a concise latest-execution line, and the latest 50 automatic/manual executions. History labels its second column `Periods / Scope`: rows show the scope recorded for that run, `Mixed` when discovery ran with other activities, or `Historical`/`Re-verification` for activity-only runs. Missing or old metadata appears as `—`. Expanded details avoid repeating scope already shown in the row. The latest Source field is omitted from the page; source remains in persisted summaries and the existing history CSV. The page offers Refresh, Export History CSV, and per-execution audit reports when available. Mongo stores one idempotently upserted history document per execution in the existing tenant-scoped `section_association_meta` collection, including optional `discoveryPeriods` and `discoveryActivities` metadata captured from actual worker results. There is no count-based history limit or TTL; MongoDB storage capacity and operator retention policies apply. Store initialization creates the `{ namespace: 1, history: 1, startedAt: -1, executionId: -1 }` history index; no migration is required. The CSV endpoint streams all retained summaries on demand. Existing columns and contents remain unchanged. Missing values remain blank, and no CSV file is retained. Both the status and CSV endpoints require the active verified LTI session and matching deployment ID. Automatic and manual runs must share the Mongo database and tenant/OAuth client namespace.

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
| `SECTION_ASSOCIATION_FIX_COMPLETED_REVERIFY_HOURS` | `24` | Minimum age before a verified completed association can be re-read during nightly maintenance. |
| `SECTION_ASSOCIATION_DISCOVERY_PERIODS` | Unset (`auto`) | Regular discovery scope. See supported values below; invalid values fail startup. |

`SECTION_ASSOCIATION_DISCOVERY_PERIODS` controls only regular fast discovery. An undefined variable, an explicitly empty value, or `auto` selects automatic scope. Only `all` selects every period on each fast cycle.

| Value | Regular discovery behavior |
| --- | --- |
| Undefined (remove the variable) | Automatic previous, current, and next periods. |
| `auto` | Same automatic behavior. |
| `2601,2602,2701` | Search exactly those periods. |
| `2701` | Search only `2701`. |
| `all` | Search every period on each fast cycle. |
| Explicit empty string | Same automatic behavior as unset or `auto`. |

Automatic periods use `America/Sao_Paulo`: `YY01` covers January–June and `YY02` covers July–December. October 2026 resolves to `2601`, `2602`, and `2701`. Values are trimmed, explicit values are deduplicated, and periods must match `YY01` or `YY02`; keywords are case-insensitive. Invalid values stop startup. In Render, configure automatic discovery by removing this variable, leaving it empty, or setting it to `auto`; configure all-period discovery by setting it to `all`. No academic-period rollover setting is needed. The `FAST_INTERVAL_MINUTES` setting controls internal-mode fast timers; the deployed Render Cron Job remains on `*/15 * * * *`.

## Hosting / Trigger Modes

### Cron mode (default)

Use `SECTION_ASSOCIATION_FIX_TRIGGER_MODE=cron` for sleeping hosting. Configure one Render Cron Job:

- Schedule: `*/15 * * * *`
- Command: `npm run cron:section-association`

Each invocation searches the configured scope. In automatic mode it queries `{period}-I0001` for the previous, current, and next periods. Explicit lists query only their listed periods. The first broad `I0001` discovery initializes historical baseline state. After that, auto and explicit modes run one complete broad historical scan daily at or after 02:00 local time. Its last successful completion is stored in tenant-scoped `section_association_meta`; a failed broad API scan leaves it due while normal configured discovery continues, and failed Mongo persistence does not advance the timestamp. A missed scan runs on the next cron invocation. In `all` mode, each fast cycle makes one broad query, uses it for both regular and full discovery, and avoids a duplicate broad request. Period configuration only selects existing Brightspace offerings to search; it cannot create an offering or recover an IPSIS import that failed.

Completed associations eligible after 24 hours are selected only between 03:00 and 06:00 `America/Sao_Paulo`; this re-verification does not run routinely during business hours. A remaining backlog continues during later 15-minute invocations in that window, with normal pending work retaining priority. Four-hour recovery continues to process non-completed pending and blocked work throughout the day. Reconciliation remains limited to 50 per cron invocation across fast and recovery work. Recovery progress advances only after eligible non-completed work is drained. The full scan and all reconciliation share the existing lease and execution; no second Render job is needed.

Cron and worker processing share an atomic namespaced Mongo lease, renewed while running and explicitly awaited on release. Expiry is crash protection. Inspect without modifying state with `npm run section-association:lease-status`.

### Internal mode

Use `SECTION_ASSOCIATION_FIX_TRIGGER_MODE=internal` only on always-on hosting. The web process runs an immediate cycle followed by configured fast and recovery timers. It uses the same namespaced Mongo lease and maintenance windows. Do not enable the external Render Cron Job while internal timers are active.

### Trigger migration

Cron → always-on: upgrade the web service, set mode to `internal`, disable/delete the Cron Job, deploy, and confirm cycles. Always-on → cron: set mode to `cron`, deploy, then enable one external Cron Job. Keep Mongo state, credentials, baseline metadata, and the same reconciliation engine.

## Unified historical and new processing

Historical baseline associations are included by the normal worker and use the same reconciliation, validation, dry-run, and apply behavior as new work. The baseline marker remains audit metadata. Each run is capped by `SECTION_ASSOCIATION_FIX_MAX_RECONCILIATIONS_PER_RUN`; new and pending records are prioritized, historical records follow, and blocked retries are handled by recovery. Completed re-verification is handled by the normal worker only during the nightly window. Legacy completed records without successful verification evidence are eligible for automatic processing.

Dry-run sends zero PUTs. A record with any active target remains pending so it can be processed when dry-run is disabled. Live updates only inactivate active targets and verify each write. Already-inactive targets are no-ops. Review operational logs and Mongo reports/state as appropriate; there is no rollback implementation.

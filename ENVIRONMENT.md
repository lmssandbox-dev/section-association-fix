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

After configuration, an LTI launch opens the read-only service status page. The endpoint checks the launch's validated deployment ID. Internal mode can report its in-memory latest cycle; cron mode only reports the active lease and cannot retrieve prior run metrics. Refresh is the only action. No CSV report, standalone validation action, cancellation, or LTI administrator allowlist is configured, so corrective controls are not available in the page.

## Service-account permissions

For the Server-to-Server Service User Client Credentials flow, the signed assertion `aud` must exactly match `BS_OAUTH2_TOKEN_ENDPOINT`; the standard endpoint is `https://auth.brightspace.com/core/connect/token`. This differs from the LTI Advantage service-token audience. The public JWKS endpoint publishes the matching public key, never the private key.

The OAuth application needs the two scopes above. Its linked Brightspace Service User needs permission to read organizational structure and Manage Courses permission to update Course Offerings.

## Section Association settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `SECTION_ASSOCIATION_FIX_DRY_RUN` | `true` | Resolve and report intended inactivations without PUT requests. |
| `SECTION_ASSOCIATION_FIX_FAST_INTERVAL_MINUTES` | `15` | Fast discovery/reconciliation cadence. |
| `SECTION_ASSOCIATION_FIX_STABILITY_MINUTES` | `10` | Minimum age for newly discovered associations. Historical records do not wait. |
| `SECTION_ASSOCIATION_FIX_RECOVERY_INTERVAL_HOURS` | `4` | Independent recovery cadence for blocked/retry work. |
| `SECTION_ASSOCIATION_FIX_MAX_RECONCILIATIONS_PER_RUN` | `50` | Maximum associations processed by a scheduled run. |
| `SECTION_ASSOCIATION_FIX_COMPLETED_REVERIFY_HOURS` | `24` | Re-read cadence for completed associations. |

## Hosting / Trigger Modes

### Cron mode (default)

Use `SECTION_ASSOCIATION_FIX_TRIGGER_MODE=cron` for sleeping hosting. Configure one Render Cron Job:

- Schedule: `*/15 * * * *`
- Command: `npm run cron:section-association`

Each invocation runs one bounded fast cycle and checks Mongo scheduler metadata for due recovery. Recovery progress advances only after all due work is processed. Align the Render schedule with `SECTION_ASSOCIATION_FIX_FAST_INTERVAL_MINUTES`.

Cron and worker processing share an atomic namespaced Mongo lease, renewed while running and explicitly awaited on release. Expiry is crash protection. Inspect without modifying state with `npm run section-association:lease-status`.

### Internal mode

Use `SECTION_ASSOCIATION_FIX_TRIGGER_MODE=internal` only on always-on hosting. The web process runs an immediate cycle followed by configured fast and recovery timers.

### Trigger migration

Cron → always-on: upgrade the web service, set mode to `internal`, disable/delete the Cron Job, deploy, and confirm cycles. Always-on → cron: set mode to `cron`, deploy, then enable one external Cron Job. Keep Mongo state, credentials, baseline metadata, and the same reconciliation engine.

## Unified historical and new processing

Historical baseline associations are included by the normal worker and use the same reconciliation, validation, dry-run, and apply behavior as new work. The baseline marker remains audit metadata. Each run is capped by `SECTION_ASSOCIATION_FIX_MAX_RECONCILIATIONS_PER_RUN`; new and pending records are prioritized, historical records follow, and blocked retry/completed re-verification work is handled by recovery. Legacy completed records without successful verification evidence are eligible for automatic processing.

Dry-run sends zero PUTs. A record with any active target remains pending so it can be processed when dry-run is disabled. Live updates only inactivate active targets and verify each write. Already-inactive targets are no-ops. Review operational logs and Mongo reports/state as appropriate; there is no rollback implementation.

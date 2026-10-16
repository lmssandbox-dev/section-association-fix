# Environment configuration

Configure these values in `.env` for local use and in the service host for deployment. Never commit credentials.

## Required application settings

| Setting | Purpose |
| --- | --- |
| `DB_MONGODB_URL` | MongoDB connection URI with an explicit application database name. |
| `APP_LTI_SECRET` | Application-internal secret used by ltijs; it is not a Brightspace LTI registration credential. |
| `PORT` | HTTP port; defaults to `3000`. |
| `BS_URL` | Brightspace HTTPS origin, such as `https://tenant.brightspace.com`. |
| `BS_NAME` | Optional Brightspace display name. |
| `BS_OAUTH2_CLIENT_ID` | Brightspace OAuth application/service-account client ID. |
| `BS_OAUTH2_PRIVATE_KEY` | RSA private key PEM used for signed JWT client authentication. |
| `BS_OAUTH2_KEY_ID` | Key ID registered for that private key. |
| `BS_OAUTH2_TOKEN_ENDPOINT` | OAuth token endpoint; required. |
| `BS_OAUTH2_SCOPES` | Must include `organizations:organization:read` and `orgunits:course:update`. |
| `D2L_API_LP_VERSION` | Brightspace Learning Platform API version in `major.minor` form. |
| `SECTION_ASSOCIATION_FIX_TRIGGER_MODE` | `cron` by default. Use `internal` only when the web service is always on. |

The Section Association worker starts with these settings and does not require an LTI launch.

## Optional LTI registration

All five settings below must be present to register the Brightspace platform and enable LTI launches. If none or only some are present, the service starts in LTI setup mode, skips platform registration, and continues serving the public bootstrap endpoints and running the worker.

| Setting | Purpose |
| --- | --- |
| `BS_LTI_CLIENT_ID` | Client ID Brightspace returns when registering this tool. |
| `BS_LTI_DEPLOYMENT_ID` | Deployment ID Brightspace returns for this tool. |
| `BS_LTI_AUTH_ENDPOINT` | Brightspace platform OIDC authorization endpoint. |
| `BS_LTI_TOKEN_ENDPOINT` | Brightspace platform access-token endpoint. |
| `BS_LTI_KEYSET_URL` | Brightspace platform keyset URL used by ltijs to validate platform requests. |

Bootstrap sequence: deploy with these settings empty; register the tool in Brightspace using the application's public keyset URL `https://<your-render-service>.onrender.com/.well-known/brightspace-jwks.json`; add the returned LTI Client ID and Deployment ID along with the platform endpoints; redeploy. The service then registers the platform. The application's public JWKS URL is distinct from `BS_LTI_KEYSET_URL`, which points to the Brightspace platform's keyset.

## Service-account permissions

The OAuth application needs the two scopes listed above granted. The linked Brightspace Service User also needs permission to read organizational structure and Manage Courses permission to update Course Offerings. Tenant administrators should verify both in a test environment.

For the Service User Client Credentials flow, the signed client assertion's `aud` must exactly match `BS_OAUTH2_TOKEN_ENDPOINT`. With the standard endpoint, use `https://auth.brightspace.com/core/connect/token`. This is the Server-to-Server Service User flow; do not use the LTI Advantage service-token audience `https://api.brightspace.com/auth/token` here. The application publishes the corresponding public key at `/.well-known/brightspace-jwks.json`; its JWK `kid` is derived from `BS_OAUTH2_KEY_ID` and its public key from `BS_OAUTH2_PRIVATE_KEY`.

## Feature settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `SECTION_ASSOCIATION_FIX_DRY_RUN` | `true` | Resolve and report intended inactivations without PUT requests. Set to `false` to enable writes. |
| `SECTION_ASSOCIATION_FIX_FAST_INTERVAL_MINUTES` | `15` | Fast discovery cadence. |
| `SECTION_ASSOCIATION_FIX_STABILITY_MINUTES` | `10` | Minimum age from first discovery before processing. |
| `SECTION_ASSOCIATION_FIX_RECOVERY_INTERVAL_HOURS` | `4` | Recovery cadence for incomplete associations. |

## Hosting / Trigger Modes

### Cron mode (default)

Use `SECTION_ASSOCIATION_FIX_TRIGGER_MODE=cron` for Render Free or any web service that can sleep. The web service continues to host LTI and the public bootstrap endpoints, but does not start in-process timers. Configure one Render Cron Job using the same repository and MongoDB/OAuth configuration:

- Schedule: `*/15 * * * *`
- Command: `npm run cron:section-association`

Each invocation runs one fast cycle, then checks the namespaced Mongo scheduler metadata to decide whether the four-hour recovery cycle is due. Recovery completion time is saved only after a successful recovery run. Cron requires `DB_MONGODB_URL`, `BS_URL`, `BS_OAUTH2_CLIENT_ID`, `BS_OAUTH2_PRIVATE_KEY`, `BS_OAUTH2_KEY_ID`, `BS_OAUTH2_TOKEN_ENDPOINT`, `BS_OAUTH2_SCOPES`, `D2L_API_LP_VERSION`, `SECTION_ASSOCIATION_FIX_DRY_RUN`, and the Section Association timing settings as needed. It does not require `APP_LTI_SECRET` or any `BS_LTI_*` setting. Keep the Render Cron schedule consistent with `SECTION_ASSOCIATION_FIX_FAST_INTERVAL_MINUTES` (default 15).

MongoDB holds an atomic namespaced cron lease and the last successful recovery time. Overlapping invocations skip while the lease is held. The same Section Association service and reconciliation engine are used in both trigger modes.

### Internal mode

Use `SECTION_ASSOCIATION_FIX_TRIGGER_MODE=internal` only on always-on hosting. The web process runs an immediate fast cycle, then repeats fast and recovery cycles using the configured minute/hour intervals. No external Cron Job is needed.

### Cron → always-on migration

1. Upgrade the web service to an always-on plan.
2. Set `SECTION_ASSOCIATION_FIX_TRIGGER_MODE=internal`.
3. Disable or delete the Render Cron Job.
4. Deploy and confirm the startup log says `[section-association] trigger mode=internal`.
5. Confirm the immediate fast cycle, a second cycle after the configured interval, and recovery timing.
6. Do not reset Mongo state or recreate the baseline. Keep the same OAuth credentials, Service User, and reconciliation engine.

### Always-on → cron migration

1. Set `SECTION_ASSOCIATION_FIX_TRIGGER_MODE=cron` and deploy the web service.
2. Create or enable the external Render Cron Job with the schedule and command above.
3. Use the same MongoDB and OAuth configuration. Do not change reconciliation or baseline state.

The first successful discovery records a no-write baseline. Existing associations are excluded from automatic processing; no historical backfill is provided. Dry-run uses the same validation and reconciliation engine as live mode.

## OAuth scopes and permissions summary

Required OAuth scopes:

- `organizations:organization:read` for orgstructure, children, and exact-code reads.
- `orgunits:course:update` for Course Offering update requests.

Required Service User permissions: organizational structure read access and Manage Courses permission for Course Offering updates. Brightspace also enforces tenant-specific visibility and access controls on each request.

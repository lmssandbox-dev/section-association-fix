# Environment configuration

Configure these values in `.env` for local use and in the service host for deployment. Never commit credentials.

## Required infrastructure and LTI settings

| Setting | Purpose |
| --- | --- |
| `DB_MONGODB_URL` | MongoDB connection URI with an explicit application database name. |
| `APP_LTI_SECRET` | Application-internal secret used by ltijs; it is not a Brightspace LTI registration credential. |
| `PORT` | HTTP port; defaults to `3000`. |
| `BS_URL` | Brightspace HTTPS origin, such as `https://tenant.brightspace.com`. |
| `BS_NAME` | Optional display name for the registered platform. |
| `BS_LTI_CLIENT_ID` | Brightspace LTI registration client ID. |
| `BS_LTI_DEPLOYMENT_ID` | Brightspace LTI deployment ID; retained for deployment configuration and not required by the background worker. |
| `BS_LTI_AUTH_ENDPOINT` | Brightspace LTI authorization endpoint. |
| `BS_LTI_TOKEN_ENDPOINT` | Brightspace LTI token endpoint. |
| `BS_LTI_KEYSET_URL` | Brightspace LTI platform key set URL. |

LTI is retained for future administrative access. The scheduled worker does not require an LTI launch.

## Service-account authentication

| Setting | Purpose |
| --- | --- |
| `BS_OAUTH2_CLIENT_ID` | Brightspace OAuth application/service-account client ID. |
| `BS_OAUTH2_PRIVATE_KEY` | RSA private key PEM used for signed JWT client authentication. |
| `BS_OAUTH2_KEY_ID` | Key ID registered for that private key. |
| `BS_OAUTH2_TOKEN_ENDPOINT` | Optional token endpoint; defaults to `https://auth.brightspace.com/core/connect/token`. |
| `BS_OAUTH2_SCOPES` | Must include `organizations:organization:read` and `orgunits:course:update`. |
| `D2L_API_LP_VERSION` | Brightspace Learning Platform API version in `major.minor` form. |

The OAuth application needs those two scopes granted. The linked Brightspace Service User also needs permission to read organizational structure and Manage Courses permission to update Course Offerings. Tenant administrators should verify both in a test environment.

## Feature settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `SECTION_ASSOCIATION_FIX_DRY_RUN` | `true` | Resolve and report intended inactivations without PUT requests. Set to `false` to enable writes. |
| `SECTION_ASSOCIATION_FIX_FAST_INTERVAL_MINUTES` | `15` | Fast discovery cadence. |
| `SECTION_ASSOCIATION_FIX_STABILITY_MINUTES` | `10` | Minimum age from first discovery before processing. |
| `SECTION_ASSOCIATION_FIX_RECOVERY_INTERVAL_HOURS` | `4` | Recovery cadence for incomplete associations. |

The first successful discovery records a no-write baseline. Existing associations are excluded from automatic processing; no historical backfill is provided. Dry-run uses the same validation and reconciliation engine as live mode.

## OAuth scopes and permissions summary

Required OAuth scopes:

- `organizations:organization:read` for orgstructure, children, and exact-code reads.
- `orgunits:course:update` for Course Offering update requests.

Required Service User permissions: organizational structure read access and Manage Courses permission for Course Offering updates. Brightspace also enforces tenant-specific visibility and access controls on each request.

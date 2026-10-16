# Environment configuration

Configure these values in `.env` for local use and in the service host for deployment. Never commit credentials.

## Required infrastructure and LTI settings

| Setting | Purpose |
| --- | --- |
| `MONGODB_URL` | MongoDB connection URI with an explicit application database name. |
| `LTI_KEY` | Secret used by ltijs to protect LTI provider data. |
| `PORT` | HTTP port; defaults to `3000`. |
| `BS_URL` | Brightspace HTTPS origin, such as `https://tenant.brightspace.com`. |
| `BS_NAME` | Optional display name for the registered platform. |
| `BS_CLIENT_ID` | Brightspace LTI registration client ID. |
| `BS_AUTH_ENDPOINT` | Brightspace LTI authorization endpoint. |
| `BS_TOKEN_ENDPOINT` | Brightspace LTI token endpoint. |
| `BS_KEYSET_URL` | Brightspace LTI platform key set URL. |

LTI is retained for future administrative access. The scheduled worker does not require an LTI launch.

## Service-account authentication

| Setting | Purpose |
| --- | --- |
| `D2L_OAUTH2_CLIENT_ID` | Brightspace OAuth application/service-account client ID. |
| `D2L_OAUTH2_PRIVATE_KEY` | RSA private key PEM used for signed JWT client authentication. |
| `D2L_OAUTH2_KEY_ID` | Key ID registered for that private key. |
| `D2L_OAUTH2_TOKEN_ENDPOINT` | Optional token endpoint; defaults to `https://auth.brightspace.com/core/connect/token`. |
| `D2L_OAUTH2_SCOPES` | Must include `organizations:organization:read` and `orgunits:course:update`. |
| `D2L_LP_VERSION` | Brightspace Learning Platform API version in `major.minor` form. |

The OAuth application needs those two scopes granted. The linked Brightspace Service User also needs permission to read organizational structure and Manage Courses permission to update Course Offerings. Tenant administrators should verify both in a test environment.

## Feature settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `SECTION_ASSOCIATION_DRY_RUN` | `true` | Resolve and report intended inactivations without PUT requests. Set to `false` to enable writes. |
| `SECTION_ASSOCIATION_FAST_INTERVAL_MINUTES` | `15` | Fast discovery cadence. |
| `SECTION_ASSOCIATION_STABILITY_MINUTES` | `10` | Minimum age from first discovery before processing. |
| `SECTION_ASSOCIATION_RECOVERY_INTERVAL_HOURS` | `4` | Recovery cadence for incomplete associations. |

The first successful discovery records a no-write baseline. Existing associations are excluded from automatic processing; no historical backfill is provided. Dry-run uses the same validation and reconciliation engine as live mode.

## OAuth scopes and permissions summary

Required OAuth scopes:

- `organizations:organization:read` for orgstructure, children, and exact-code reads.
- `orgunits:course:update` for Course Offering update requests.

Required Service User permissions: organizational structure read access and Manage Courses permission for Course Offering updates. Brightspace also enforces tenant-specific visibility and access controls on each request.

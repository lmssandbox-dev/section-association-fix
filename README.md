# Brightspace Section Association Fix

This service detects Course Offerings created by IPSIS Section Association processing and inactivates the original standalone Course Offerings represented by their grouped sections. It does not rename or delete anything, move groups, or change enrollments or mappings.

## How it works

The worker searches `GET /d2l/api/lp/{version}/orgstructure/?orgUnitType=3&orgUnitCode=I0001`, follows every bookmark page, and filters results using `^\\d{6}-\\d{2}-\\d{4}-I0001$`. Each valid association must be a Course Offering with at least one direct Group child; each child code must end in a hyphen and exactly five digits. Removing that suffix produces an original Course Offering code that must resolve to exactly one Course Offering.

The worker validates the complete target set before writing. It re-reads each current Course Offering, skips already-inactive records, and only changes `IsActive` to `false` through a full PUT followed by a verification GET. Dry-run performs the same discovery and validation but sends no PUTs; active targets stay pending for later live processing.

## Unified processing and safety

The first successful discovery records the current association population with `baseline: true` for audit history. Baseline status does not permanently exclude an association: historical and new records use the same reconciler. Historical records do not wait through the new-association stability window. New records wait `SECTION_ASSOCIATION_FIX_STABILITY_MINUTES` (default 10).

Each scheduled run handles at most `SECTION_ASSOCIATION_FIX_MAX_RECONCILIATIONS_PER_RUN` associations (default 50), prioritizing new and pending work, then historical records, then controlled blocked retries and due completed re-verification. Previously completed records without positive verification evidence are eligible automatically. Completed associations are re-read every `SECTION_ASSOCIATION_FIX_COMPLETED_REVERIFY_HOURS` (default 24); if a target is active again, it is reconciled through the normal validation and update path.

Dry-run and live processing share the same engine. Every target is checked before the first write. The only mutation is Course Offering `IsActive: true` to `false`; uncertain writes are read back and never blindly replayed. MongoDB is an operational work ledger, not proof of Brightspace state.

## Authentication

Background calls use Brightspace Server-to-Server OAuth 2.0 client credentials with a signed private-key JWT. LTI 1.3 registration is optional at startup and is unrelated to worker authentication. The service account needs `organizations:organization:read` and `orgunits:course:update`, plus Brightspace organizational-structure read access and Manage Courses permission.

## Hosting / Trigger Modes

`SECTION_ASSOCIATION_FIX_TRIGGER_MODE=cron` is the default for Render Free and other sleeping web services. Configure one Render Cron Job from this repository on `*/15 * * * *` with command `npm run cron:section-association`. Each invocation performs one bounded fast cycle and runs recovery when its independent four-hour schedule is due.

Cron and the worker use a namespaced Mongo lease. It is renewed during work and explicitly released after success or failure; expiry is crash protection. Run `npm run section-association:lease-status` to inspect its state without modifying MongoDB.

Set `SECTION_ASSOCIATION_FIX_TRIGGER_MODE=internal` only on always-on hosting. The web process starts an immediate fast cycle and recurring fast/recovery timers. Both modes use the same service and reconciliation engine.

## LTI bootstrap

Deploy first with the `BS_LTI_*` settings empty. The application starts in LTI setup mode, runs the Section Association worker, and serves `/ping` and `/.well-known/brightspace-jwks.json`. Register the tool in Brightspace using the public application keyset URL `https://<your-render-service>.onrender.com/.well-known/brightspace-jwks.json` (or the equivalent configured public domain). Then add the returned LTI Client ID and Deployment ID, plus all required platform endpoints, and redeploy. LTI launches are enabled after the complete configuration is present.

## LTI status page

An authenticated Brightspace launch opens a compact status page with service availability, worker state, and the latest observed bounded cycle details. In internal trigger mode, the page can show the current process's latest cycle counters. In cron mode, the web service can show whether the cron lease is active, but the one-shot cron process does not persist execution summaries; date, counts, and outcome are therefore unavailable between cron invocations. Cycle completion does not mean a complete scan; the worker is capped at 50 associations per run by default, and full-scan completion is not tracked. The page only supports Refresh. There is no existing CSV report, standalone read-only validation operation, safe cancellation, or configured LTI administrator allowlist, so no such controls or corrective trigger are exposed. The status API is protected by the validated LTI session and configured deployment ID.

## Run

Use Node.js 22, install with `npm ci`, copy `.env.example` to `.env`, and provide credentials. Run `npm test` and `npm run check`; start with `npm start`. Keep dry-run enabled until logs confirm the expected targets. Set `SECTION_ASSOCIATION_FIX_DRY_RUN=false` only when ready to permit inactivation.

See [ENVIRONMENT.md](ENVIRONMENT.md) for configuration and [TECHNICAL.md](TECHNICAL.md) for persistence and scheduling details.

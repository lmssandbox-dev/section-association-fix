# Project guide

Brightspace Section Association Fix is a Node.js 22 service that discovers IPSIS Section Association Course Offerings, resolves grouped sections to original standalone Course Offerings, and inactivates those originals.

## Architecture

- `index.js` composes web configuration, optional LTI setup, and trigger mode.
- `src/shared/` contains service-account OAuth, HTTPS/API transport, Mongo URL validation, and shared rate limiting.
- `src/sectionAssociations/` contains discovery, resolution, validation, persistence, scheduling, and one reconciliation engine shared by cron and internal modes.
- The recurring Section Association Fix worker is the production processing path; historical baseline records are included in its bounded work selection.

The worker uses only the Brightspace OAuth service account. LTI is not required for reconciliation. When LTI registration is configured, the launch page provides a small authenticated, read-only status view.

## Trigger modes

`SECTION_ASSOCIATION_FIX_TRIGGER_MODE=cron` is the default for sleeping web services. Configure one Render Cron Job on `*/15 * * * *` using `npm run cron:section-association`. Each invocation runs one bounded fast cycle and the independent recovery cycle when due. The default reconciliation limit is 50 per run.

Use `internal` only on always-on hosting; it starts an immediate fast cycle and recurring fast/recovery timers. Both modes share the same service, lease, and reconciliation engine. Never run the external cron while internal timers are active.

## Eligibility and status

`baseline: true` is audit metadata and never permanently excludes a valid association. New associations wait the configured stability window (default ten minutes); historical baseline records do not. Records are processed through the same validation and reconciler. Legacy completed records without positive successful verification evidence are eligible automatically. Verified completed records are re-read every 24 hours by default.

Every association requires a Course Offering with the exact code pattern `^\\d{6}-\\d{2}-\\d{4}-I0001$`, at least one direct Group child, valid five-digit child suffixes, and exactly one distinct Course Offering for every derived code. Validate all targets before writing. Inactive targets are no-ops. The only Brightspace mutation is a full Course Offering PUT changing `IsActive` from true to false, followed by verification. Never replay an uncertain write.

Dry-run is the default and sends zero PUTs. If active targets remain, keep the record pending for later live processing. Do not change OAuth, LTI, discovery, association rules, Mongo state semantics, reconciliation, or scheduler intervals without explicit task scope.

## LTI interface

The LTI launch page shows service availability and worker state, plus the latest execution result only when the web process can observe it. Internal mode reports in-process cycle counters. Cron mode reports an active lease but has no persisted run history, so latest counts/date are unavailable. Cycle counters are bounded-run results; they do not establish that a complete scan finished. Historical backlog can identify some partial work. The UI has Refresh only. There is no existing standalone read-only validation action, CSV report, safe cancellation mechanism, or configured administrator allowlist; do not add these actions or expose corrective operations without separately scoped backend authorization and support. The status endpoint requires a verified LTI session and the configured deployment ID, and responses are not cached. Browser status requests send the launch's ltijs token in `Authorization: Bearer` and retain same-origin credentials; ltijs continues validating the token and its session cookie on every request.

## Development

Run `npm test` and `npm run check`. Keep real secrets out of source control. See `README.md`, `ENVIRONMENT.md`, and `TECHNICAL.md` for configuration and operations.

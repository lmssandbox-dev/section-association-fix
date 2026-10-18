# Project guide

Brightspace Section Association Fix is a Node.js 22 service that discovers IPSIS Section Association Course Offerings, resolves grouped sections to original standalone Course Offerings, and inactivates those originals.

## Architecture

- `index.js` composes web configuration, optional LTI setup, and trigger mode.
- `src/shared/` contains service-account OAuth, HTTPS/API transport, Mongo URL validation, and shared rate limiting.
- `src/sectionAssociations/` contains discovery, resolution, validation, persistence, scheduling, and one reconciliation engine shared by cron and internal modes.
- The recurring Section Association Fix worker is the production processing path; historical baseline records are included in its bounded work selection.

The worker uses only the Brightspace OAuth service account. LTI is not required for reconciliation. When LTI registration is configured, the launch page provides a small authenticated, read-only status view.

## Trigger modes

`SECTION_ASSOCIATION_FIX_TRIGGER_MODE=cron` is the default for sleeping web services. Use the existing single Render Cron Job on `*/15 * * * *` with `npm run cron:section-association`. Every 15 minutes, it discovers current and previous academic periods; after 02:00 `America/Sao_Paulo`, it also runs the daily broad historical scan when due. The first run performs broad discovery to initialize the baseline. Four-hour recovery handles pending and blocked work, while eligible completed associations are re-verified only from 03:00–06:00 local time. Cron and internal runs share the Mongo lease and reconciliation engine; cron fast and recovery work share the limit of 50 reconciliations per invocation. Existing validation, dry-run, and verified-write safety rules apply.

Use `internal` only on always-on hosting; it starts an immediate fast cycle and recurring fast/recovery timers. Both modes share the same Mongo lease, service, and reconciliation engine. Never run the external cron while internal timers are active.

## Eligibility and status

Academic periods are automatic and use the `America/Sao_Paulo` calendar: January–June is `YY01`; July–December is `YY02`. Every fast discovery queries both `{period}-I0001` codes. A successful broad `I0001` scan is timestamped in tenant-scoped Mongo metadata and is due once daily after 02:00 local time; failures remain due for retry. It preserves historical and future-period coverage without querying every historical association every 15 minutes. `baseline: true` is audit metadata and never permanently excludes a valid association. New associations wait the configured stability window (default ten minutes); historical baseline records do not. Legacy completed records without positive successful verification evidence remain eligible automatically. Verified completed records become eligible after 24 hours and are re-read only during the maintenance window; pending and blocked recovery work continues throughout the day.

Every association requires a Course Offering with the exact code pattern `^\\d{6}-\\d{2}-\\d{4}-I0001$`, at least one direct Group child, valid five-digit child suffixes, and exactly one distinct Course Offering for every derived code. Validate all targets before writing. Inactive targets are no-ops. The only Brightspace mutation is a full Course Offering PUT changing `IsActive` from true to false, followed by verification. Never replay an uncertain write.

Dry-run is the default and sends zero PUTs. If active targets remain, keep the record pending for later live processing. Do not change OAuth, LTI, discovery, association rules, Mongo state semantics, reconciliation, or scheduler intervals without explicit task scope.

Discovery persistence compares valid, distinct association IDs against the tenant-scoped `section_associations` collection in batches of 500. Only IDs missing from the comparison are upserted with `$setOnInsert`; already-known records are refreshed in bounded bulk writes so `lastSeenAt` retains its operational meaning without per-association round trips. Discovery and baseline bulk operations are bounded, counters count distinct valid association IDs, duplicate-key races are handled idempotently, and partial database failures must fail the cycle.

## LTI interface

The LTI launch page is a compact, read-only monitor with service status and execution history. It shows the 50 newest automatic/manual executions with aligned date, source, outcome, and count columns; numeric counts are right-aligned and locale-formatted. Narrow frames use labelled two-column rows. Expanded rows use one compact strip: successful zero-work runs show “No work required” and duration; processed runs show Already compliant and duration; failed/incomplete runs show available duration and an existing explanation. An accessible Reports dropdown offers Corrections CSV and Exceptions CSV when detailed auditing is available; older runs show a short unavailable message. A latest execution that completed with zero associations checked and zero errors shows “No associations needed processing.” instead of its three summary counters. Refresh and Export History CSV remain available; the history export includes every retained execution, not only those displayed. Feedback is transient on success and remains accessible for errors. Execution summaries are stored as one idempotently upserted document per execution in tenant-scoped `section_association_meta`. Detailed rows are separate documents in `section_association_audit`, uniquely indexed by namespace, execution ID, kind, and stable record key, with a retrieval index by namespace, execution ID, and kind. No TTL or count-based pruning is applied. Corrections record only actual read-back-verified state changes; the aggregate correction counter remains association-level. Exceptions distinguish validation blocks, failed updates, failed verification, and unexpected failures; exception row counts do not define aggregate errors. Both audit exports require the verified LTI session and configured deployment ID. CSV output is generated from MongoDB on demand, escapes CSV and spreadsheet formulas, and does not call Brightspace. Automatic and manual execution are covered. Historical runs without `detailedAuditAvailable: true` have no verified detail coverage and are not exported as zero activity. Indexes are created automatically at store initialization; no data migration is required. Do not add corrective operations without separate backend authorization and support.

## Development

Run `npm test` and `npm run check`. Keep real secrets out of source control. See `README.md`, `ENVIRONMENT.md`, and `TECHNICAL.md` for configuration and operations.

# Brightspace Section Association Fix

This service detects Course Offerings created by IPSIS Section Association processing and inactivates the original standalone Course Offerings represented by their grouped sections. It does not rename or delete anything, move groups, or change enrollments or mappings.

## How it works

Every 15 minutes the worker discovers the current and previous academic periods using separate `orgUnitCode={period}-I0001` queries. Period selection is automatic in `America/Sao_Paulo`: `YY01` means January–June and `YY02` means July–December. For example, in October 2026 the fast queries are `2602-I0001` and `2601-I0001`. A broad `orgUnitCode=I0001` scan covers all periods once daily after 02:00 local time; a fresh installation completes this full scan for its initial baseline before using period-scoped discovery. All queries follow Brightspace pagination and apply the same exact association-code validation. Each valid association must be a Course Offering with at least one direct Group child; each child code must end in a hyphen and exactly five digits. Removing that suffix produces an original Course Offering code that must resolve to exactly one Course Offering.

Discovery persistence compares distinct valid association IDs with the tenant-scoped Mongo collection in batches of 500. Existing records are refreshed in bounded bulk writes to preserve `lastSeenAt`; only IDs not found are inserted using `$setOnInsert`, preserving existing reconciliation state and baseline metadata. Bulk writes are bounded, duplicate-key races remain idempotent, and partial database failures fail the cycle.

The worker validates the complete target set before writing. It re-reads each current Course Offering, skips already-inactive records, and only changes `IsActive` to `false` through a full PUT followed by a verification GET. Dry-run performs the same discovery and validation but sends no PUTs; active targets stay pending for later live processing.

## Unified processing and safety

The first successful discovery records the current association population with `baseline: true` for audit history. Baseline status does not permanently exclude an association: historical and new records use the same reconciler. Historical records do not wait through the new-association stability window. New records wait `SECTION_ASSOCIATION_FIX_STABILITY_MINUTES` (default 10).

Each scheduled run handles at most `SECTION_ASSOCIATION_FIX_MAX_RECONCILIATIONS_PER_RUN` associations (default 50), prioritizing new and pending work, then historical records, then controlled blocked retries. Previously completed records without positive verification evidence are eligible automatically. Verified completed associations become eligible every `SECTION_ASSOCIATION_FIX_COMPLETED_REVERIFY_HOURS` (default 24), and are re-read only from 03:00 through 06:00 America/Sao_Paulo. Backlogs resume in later maintenance windows. If a target is active again, it is reconciled through the normal validation and update path.

Dry-run and live processing share the same engine. Every target is checked before the first write. The only mutation is Course Offering `IsActive: true` to `false`; uncertain writes are read back and never blindly replayed. MongoDB is an operational work ledger, not proof of Brightspace state.

## Authentication

Background calls use Brightspace Server-to-Server OAuth 2.0 client credentials with a signed private-key JWT. LTI 1.3 registration is optional at startup and is unrelated to worker authentication. The service account needs `organizations:organization:read` and `orgunits:course:update`, plus Brightspace organizational-structure read access and Manage Courses permission.

## Hosting / Trigger Modes

`SECTION_ASSOCIATION_FIX_TRIGGER_MODE=cron` is the default for Render Free and other sleeping web services. Configure one Render Cron Job from this repository on `*/15 * * * *` with command `npm run cron:section-association`. Each invocation performs bounded period discovery and runs non-completed recovery when its independent four-hour schedule is due. Nightly full discovery and completed-association verification use the same cron job; no additional job is needed.

### Daily schedule at a glance

| Work | Timing | Discovery or processing |
| --- | --- | --- |
| Fast discovery | Every 15 minutes | Current and previous periods; October 2026 uses `2602-I0001` and `2601-I0001`. |
| Full discovery | Once daily, at or after 02:00 `America/Sao_Paulo` | Broad `I0001` query covers historical and future periods. If missed or unsuccessful, the next cron invocation retries it. |
| Completed re-verification | 03:00–06:00 `America/Sao_Paulo` | Only completed associations at least 24 hours past successful verification are eligible. |
| Recovery | Every four hours | Pending and retryable blocked work remains eligible throughout the day. |

This keeps each fast discovery focused on the current and immediately previous periods, reducing repeated Brightspace reads across older history. The daily broad scan still finds associations in any past or future period, so narrowing the frequent queries does not remove historical coverage. No academic-period setting or second cron job is needed.

Cron and the worker use a namespaced Mongo lease. It is renewed during work and explicitly released after success or failure; expiry is crash protection. Run `npm run section-association:lease-status` to inspect its state without modifying MongoDB.

Set `SECTION_ASSOCIATION_FIX_TRIGGER_MODE=internal` only on always-on hosting. The web process starts an immediate fast cycle and recurring fast/recovery timers. Cron and internal runs coordinate through the same Mongo lease, service, and reconciliation engine.

## LTI bootstrap

Deploy first with the `BS_LTI_*` settings empty. The application starts in LTI setup mode, runs the Section Association worker, and serves `/ping` and `/.well-known/brightspace-jwks.json`. Register the tool in Brightspace using the public application keyset URL `https://<your-render-service>.onrender.com/.well-known/brightspace-jwks.json` (or the equivalent configured public domain). Then add the returned LTI Client ID and Deployment ID, plus all required platform endpoints, and redeploy. LTI launches are enabled after the complete configuration is present.

## LTI status page

An authenticated Brightspace launch opens a compact read-only monitor with service availability, current worker state, current and previous **Discovery periods**, the latest execution summary, and the 50 newest executions. History uses aligned date, **Discovery scope**, outcome, and right-aligned count columns; counts use locale-aware grouping. On narrow frames entries become labelled two-column rows. Scope labels (`Current + Previous`, `Historical`, `Re-verification`, `Mixed`) come only from recorded activities; missing evidence displays `Not recorded`. Expanded rows show recorded period identifiers and activities in one compact strip, along with existing duration and Already compliant details. Successful zero-work runs show “No work required” and duration; failed/incomplete runs show available duration and an existing explanation. Audited rows retain the keyboard-accessible Reports dropdown. A successful latest execution with zero associations checked and zero errors shows “No associations needed processing.” instead of summary counters. The page omits execution IDs, coverage, and historical backlog; these remain in stored summaries and CSV exports. Export feedback clears after success and announces errors accessibly. Refresh and Export History CSV are the page-level actions. To run the existing one-shot process as manual maintenance, use `node scripts/run-section-association.js --manual`; without that flag (including the configured Render cron command), the source is automatic.

Summary counters count associations, not target writes: checked counts reconciliation attempts; already compliant counts associations whose resolved targets were all already inactive; corrections applied counts associations with one or more verified target updates; errors count failed association outcomes and known execution-level failures. Execution summaries persist period identifiers and only activities that actually ran. Period query evidence is recorded after both current/previous queries complete; historical discovery is recorded only after the broad query succeeds; re-verification is recorded when such a work item is processed. Older records remain unchanged and display `Not recorded`. Coverage contains the historical backlog count only when the worker returned it; this bounded-cycle value does not establish full-scan completion. If there is no execution, the page shows “No maintenance execution recorded yet.” Automatic and manual summaries are stored as one document per execution ID in the tenant-scoped `section_association_meta` collection. Writes are idempotent by execution ID; history has no count-based pruning or TTL, and is retained subject to MongoDB capacity and operational storage policy. Store initialization creates the `{ namespace: 1, history: 1, startedAt: -1, executionId: -1 }` index; no migration is required. Existing documents remain available, but records already deleted by the previous five-entry pruning cannot be reconstructed. Download CSV streams all retained execution summaries on demand, including records beyond the 50 shown in the page. Its existing columns (including execution ID and source) are preserved; discovery period identifiers and activities are appended. Missing stored values are blank; the CSV is not persisted. Both status and CSV endpoints require a validated LTI session and matching configured deployment ID, and responses are not cached. The browser sends the launch-generated ltijs token as a Bearer token plus same-origin credentials, which ltijs validates along with its session cookie; a 401 requires a fresh Brightspace launch.

## Run

Use Node.js 22, install with `npm ci`, copy `.env.example` to `.env`, and provide credentials. Run `npm test` and `npm run check`; start with `npm start`. Keep dry-run enabled until logs confirm the expected targets. Set `SECTION_ASSOCIATION_FIX_DRY_RUN=false` only when ready to permit inactivation.

See [ENVIRONMENT.md](ENVIRONMENT.md) for configuration and [TECHNICAL.md](TECHNICAL.md) for persistence and scheduling details.

## Detailed audit exports

Each new automatic or manual execution stores verified Course Offering corrections and meaningful exceptions as separate records in MongoDB `section_association_audit`, linked by execution ID. The authenticated LTI history provides a per-execution Reports dropdown for Corrections CSV and Exceptions CSV when audit coverage is established; older runs show “Detailed reports unavailable.” The page-level action is labelled Export History CSV and exports every retained execution, including runs beyond the 50 displayed. Menus support keyboard dismissal and success feedback clears automatically. Expanded execution details use a compact strip with status-appropriate duration/count information. Corrections represent verified state changes; exception rows do not redefine the existing association-level error count. Audit rows are retained incrementally without an application TTL or count limit. Store initialization creates the audit retrieval and idempotency indexes; no migration or extra Brightspace lookup is required.

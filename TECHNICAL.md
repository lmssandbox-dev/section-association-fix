# Technical overview

## Components

`index.js` composes the web application, optional LTI provider, and trigger mode. `src/sectionAssociations/runtime.js` builds the OAuth service-account client, Mongo-backed rate-limited transport, store, reconciler, and service; the web and one-shot cron entrypoints share this runtime.

`client.js` contains bounded bookmark pagination and feature-specific API calls. `rules.js` enforces the association code and child suffix patterns. `resolver.js` validates every direct Group child and resolves exact Course Offering codes. `reconciler.js` validates every target before writes, then performs GET → full PUT → verification GET. `store.js` tracks association metadata, positive reconciliation evidence, baseline audit state, successful full-discovery timestamps, and the shared worker lease. `service.js` handles period-aware discovery, bounded priority selection, and fast/recovery passes.

For scheduling, `client.js` accepts the broad `I0001` query or a validated four-digit period plus `-I0001`; `config.js` parses and validates `SECTION_ASSOCIATION_DISCOVERY_PERIODS`, and `service.js` resolves the configured scope and coordinates full, fast, and maintenance-window selection. `store.js` performs batched discovery persistence and stores full-scan completion and recovery state. `cron.js` enforces the shared 50-item invocation limit, while `scheduler.js` provides internal timers; both use the same distributed lease.

The LTI provider is optional during bootstrap. Worker code uses only the Server-to-Server OAuth service account.

When configured, the LTI launch page groups availability and worker state, shows the actual discovery period codes in bold or “All periods”, and presents latest date and outcome. It omits the latest Source field and suppresses a zero-work message that is already clear from the history counts. History replaces its visible source column with `Periods / Scope`, preserving source in storage and CSV. Rows display recorded scope; `Mixed` is appended when discovery ran with other activities. Historical-only and re-verification-only runs show their activity labels, while old or incomplete records without scope evidence show `—`. Expandable rows show concise work information and duration or failure explanations, with scope already represented in the main row. Successful zero-work rows show “No work required” and duration. Refresh and Export History CSV remain available; the latter downloads all retained runs. Success feedback clears automatically, while errors remain announced accessibly. Execution IDs, coverage, and historical backlog stay in persisted summaries and CSV but are omitted from the page. Each request sends the launch-generated ltijs token in the `Authorization: Bearer` header and same-origin credentials. ltijs validates the token and session cookie before the route checks the verified deployment ID. The status endpoint reads the latest summary and latest 50 history documents from `section_association_meta`. Each execution is stored as a separate history document keyed by tenant and execution ID; upsert makes repeated writes with that ID idempotent. No history pruning or TTL is applied. The latest-summary document remains selected by start timestamp across sources. Automatic internal/cron and manual one-shot executions share the schema and history.

The history query index is `{ namespace: 1, history: 1, startedAt: -1, executionId: -1 }` and is created during store initialization. Existing data needs no migration; MongoDB creates the index on the next store initialization. CSV export streams all history documents through a cursor in batches of 500, formats the stored execution fields on demand, and does not create a permanent report. The CSV route uses the same LTI session and deployment verification as status. History consumes storage indefinitely until an operator applies normal MongoDB storage policies or capacity constraints; there is no application count limit or TTL.

The Execution History interface displays 50 records per page and queries MongoDB with `skip`/`limit` plus one lookahead record; ordering is `startedAt` descending and `executionId` descending. Optional From and To filters query `startedAt` directly using inclusive São Paulo calendar dates converted to local-midnight UTC boundaries. Filter changes return the interface to page 1. The status response includes `history.page` and `history.hasMore`; malformed pages/dates and reversed ranges receive HTTP 400. Export History CSV remains a separate cursor over all retained history, unaffected by page or date filters. Detailed report links remain attached to each displayed execution and work on every page. Pagination and filtering add no retention or deletion policy.

The summary contains a UUID, `source`, start/completion dates, final status, optional association-level counters and coverage metadata, plus optional `discoveryPeriods` (`mode`, `periods`, and automatic `previous`, `current`, `next`) and `discoveryActivities` markers (`periods`, `historical`, `reverification`). Scope is recorded after all configured period queries complete; historical discovery is marked only after the broad query succeeds; re-verification is marked when a re-verification item is processed. Cron summaries combine evidence from their fast and recovery passes. Failed/incomplete runs retain only evidence collected before failure, and legacy documents are not backfilled. The history CSV appends period identifiers and activity labels after the existing columns; source and all previous fields retain their names and positions. Duration is calculated from the recorded start and finish times in the page. The UI does not surface coverage or backlog; these persisted values remain available in CSV export. The web process receives no external cron expression/timezone, so next execution is reported unavailable. Summary-write failures are safely logged. Current worker activity comes from the in-process scheduler or shared cron lease. The UI exposes no operation that mutates course offerings.

## Reconciliation algorithm

1. Require association Course Offering type and code `^\\d{6}-\\d{2}-\\d{4}-I0001$`.
2. Read bounded child pages. Require at least one child; every child must be Type `Group` and end with `-\\d{5}`.
3. Derive each original Course Offering code by removing the five-digit child suffix; reject duplicate derived codes.
4. Resolve every derived code exactly once and require a distinct Course Offering ID.
5. GET and validate all current targets and build safe full update payloads before the first write.
6. Leave inactive targets unchanged. In dry-run report active targets and keep the association pending. In live mode re-read each active target immediately before PUT, change only `IsActive`, then read back and verify.
7. Mark complete only after every target is confirmed inactive. Store `lastReconciledAt`, `lastVerifiedAt`, and `reconciliationVersion` as positive evidence. Block validation failures; leave transient/uncertain work retryable.

The PUT body preserves all current Course Offering fields and converts Brightspace RichText Description to RichTextInput. An uncertain PUT is read back and never blindly replayed.

## Baseline, eligibility, and scheduling

`SECTION_ASSOCIATION_DISCOVERY_PERIODS` is optional. An undefined value, explicitly empty value, or case-insensitive `auto` uses `Intl.DateTimeFormat` in `America/Sao_Paulo` to resolve previous/current/next. January–June maps to `YY01`, July–December to `YY02`; previous and next roll across years. October 2026 resolves to `2601`, `2602`, `2701`; February 2027 to `2602`, `2701`, `2702`; August 2027 to `2701`, `2702`, `2801`. A comma-separated list (for example `2601,2602,2701`) selects exactly those periods after trimming and deduplication; a single period such as `2701` is also valid. Only `all` selects broad discovery every fast cycle. Keywords are case-insensitive, and malformed values fail startup. In Render, remove the setting, leave it empty, or use `auto` for automatic discovery; use `all` for all-period discovery. Period configuration selects Brightspace offerings to query; it does not restore an association that a failed IPSIS import never created.

Auto and explicit fast passes make a fully paginated Brightspace request for each selected period:

```text
GET /d2l/api/lp/{version}/orgstructure/?orgUnitType=3&orgUnitCode={period}-I0001
```

The broad `orgUnitCode=I0001` scan is fully paginated and covers all historical and future periods, finding associations outside the regular scope without repeating that broad read every 15 minutes in auto/explicit modes. The first broad query initializes the baseline. Later full scans are due once daily at or after 02:00 local time. Their successful completion is timestamped in tenant-scoped `section_association_meta` only after records persist; missed executions remain due at the next invocation. If a broad query fails on an established tenant, its timestamp stays unchanged and regular period discovery continues; initial baseline failure stops the cycle. Mongo persistence failures fail the cycle and do not mark completion. In `all` mode, each fast cycle runs one broad query, persists its discoveries, and uses the same result as full discovery, avoiding a duplicate query.

The first successful full discovery uses a Mongo baseline lease and marks associations already present as `baseline: true` for audit. Baseline does not suppress reconciliation. Historical and new associations go through the same reconciler; historical work has no new-association stability delay. New associations wait the configured stability duration.

Each scheduled run processes at most `SECTION_ASSOCIATION_FIX_MAX_RECONCILIATIONS_PER_RUN` (default 50), in deterministic priority order: stable new/pending work, historical baseline work, and controlled blocked retries. Cron passes the fast discovery result into its recovery pass so discovery is not repeated within one invocation; fast plus recovery share the 50-item limit. Legacy completed records without positive verification evidence remain eligible automatically. Verified completed records become eligible every `SECTION_ASSOCIATION_FIX_COMPLETED_REVERIFY_HOURS` (default 24), but the selector includes them only from 03:00 through 06:00 `America/Sao_Paulo`. New/pending and blocked work remains eligible throughout the day and has priority over completed verification. A remaining completed backlog resumes on later 15-minute invocations in the next maintenance window. If a target is active again, normal validation and safe read-back verification apply.

Cron mode runs one bounded fast pass per external invocation and uses persisted `lastRecoveryAt` to keep the four-hour pending/blocked recovery schedule independent. The recovery pass reuses the fast pass's discovery and consumes only the remaining part of the shared 50-reconciliation limit. Internal mode runs immediate and recurring fast/recovery timers through the same service functions. Both modes acquire and renew the same namespaced Mongo worker lease and await release; this prevents overlapping scans and reconciliation across cron/internal instances, with lease expiry providing crash recovery.

Completed associations with positive verification evidence become eligible after the configured 24-hour interval, but only the fast selector includes them between 03:00 and 06:00 `America/Sao_Paulo`. They use the same bounded validation and reconciliation path. Pending, historical, and retryable blocked work retains priority and remains eligible outside that window. A completed-work backlog is served in available capacity during the window and resumes in the next window if needed; each verified result updates its existing verification timestamp, so completed work is not needlessly repeated. No additional Render job or timezone setting is required, and automatic period rollover needs no manual maintenance.

```mermaid
flowchart TD
  A[Fast tick every 15 minutes] --> B[Resolve configured scope]
  B --> C{Scope is all?}
  C -- Yes --> D[One broad I0001 query; persist and mark full scan]
  C -- No --> E{Initial baseline or full scan due after 02:00?}
  E -- Yes --> F[Paginate broad I0001 scan and persist success timestamp]
  E -- No --> G[Skip broad scan]
  F --> H[Query configured periods and persist distinct IDs]
  G --> H
  D --> I[Select priority work; max 50, completed re-verification only 03:00–06:00]
  H --> I
  I --> J{Four-hour recovery due?}
  J -- Yes --> K[Recover pending and blocked work within remaining limit]
  J -- No --> L[Finish]
  K --> L
```

## Persistence

`section_associations` is keyed by tenant namespace and `associationOrgUnitId`. It stores association code, first/last seen and checked times, status, audit baseline marker, safe errors, compact outcomes, and positive verification evidence. `section_association_meta` stores baseline coordination, cron lease/recovery metadata, and the last successful broad discovery timestamp. Mongo is an operational work ledger; current Brightspace records remain authoritative.

After the baseline is ready, discovery deduplicates valid association IDs and compares them with Mongo in tenant-scoped `$in` queries of at most 500 IDs, supported by the existing unique `{ namespace: 1, associationOrgUnitId: 1 }` index. Known records receive a bounded bulk refresh of `associationCode` and `lastSeenAt`; inserts are limited to IDs absent from the comparison and use bounded unordered bulk upserts with `$setOnInsert`, preserving existing state, first-seen time, baseline marker, and reconciliation evidence. Duplicate-key races are confirmed against Mongo and counted as already known. Initial baseline writes are chunked to the same bound and still mark only inserted records as baseline. Counters count distinct valid discovered IDs. A partial bulk failure fails the execution so it cannot be reported as complete; already-applied operations are safe to observe on the next cycle.

## Transport and write boundary

JWT exchange is shared with the application. Brightspace URLs remain HTTPS on the configured origin; redirects are disabled, request timeouts are bounded, API traffic passes through the shared rate gate, and errors omit credentials. The feature's only write is a narrowly scoped Course Offering PUT.

## Detailed execution audit

Each scheduled or manual execution passes its UUID and source into the shared reconciler. After a PUT is verified inactive, it upserts one `correction` record into `section_association_audit`; the stable key is execution, parent association, and target offering. Validation blocks, update failures, verification failures, and unexpected association failures produce deduplicated `exception` records with sanitized explanations. Corrections are target-level; the existing `correctionsApplied` value remains association-level (at least one verified target update). Audit write failures mark execution detail coverage incomplete, and completed writes remain persisted if a later operation fails.

The audit collection has a unique `{ namespace: 1, executionId: 1, kind: 1, recordKey: 1 }` index and an execution retrieval `{ namespace: 1, executionId: 1, kind: 1 }` index, created at store initialization. LTI Corrections CSV and Exceptions CSV endpoints require the same verified session and deployment check as history export. They stream rows from Mongo on demand, safely escape CSV/formula content, and make no Brightspace calls. Empty reports have headers. Only summaries marked `detailedAuditAvailable` show report actions; older executions without that marker are explicitly unavailable, not treated as zero. No TTL or application retention cap is applied; storage follows MongoDB capacity and operator policy. No migration is required.

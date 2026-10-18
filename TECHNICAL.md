# Technical overview

## Components

`index.js` composes the web application, optional LTI provider, and trigger mode. `src/sectionAssociations/runtime.js` builds the OAuth service-account client, Mongo-backed rate-limited transport, store, reconciler, and service; the web and one-shot cron entrypoints share this runtime.

`client.js` contains bounded bookmark pagination and feature-specific API calls. `rules.js` enforces the association code and child suffix patterns. `resolver.js` validates every direct Group child and resolves exact Course Offering codes. `reconciler.js` validates every target before writes, then performs GET → full PUT → verification GET. `store.js` tracks association metadata, positive reconciliation evidence, baseline audit state, and cron lease metadata. `service.js` handles discovery, bounded priority selection, and fast/recovery passes.

The LTI provider is optional during bootstrap. Worker code uses only the Server-to-Server OAuth service account.

When configured, the LTI launch page shows service availability, current worker state, latest execution summary, and the latest 50 executions. History retains aligned count columns and expandable rows; details show only duration, already-compliant associations, and start/finish times, while errors remain visible in the table. A successful zero-work latest run replaces summary counters with “No associations needed processing.” Refresh and Download CSV remain available. Execution IDs, coverage, and historical backlog stay in persisted summaries and CSV but are omitted from the page. Each request sends the launch-generated ltijs token in the `Authorization: Bearer` header and same-origin credentials. ltijs validates the token and session cookie before the route checks the verified deployment ID. The status endpoint reads the latest summary and latest 50 history documents from `section_association_meta`. Each execution is stored as a separate history document keyed by tenant and execution ID; upsert makes repeated writes with that ID idempotent. No history pruning or TTL is applied. The latest-summary document remains selected by start timestamp across sources. Automatic internal/cron and manual one-shot executions share the schema and history.

The history query index is `{ namespace: 1, history: 1, startedAt: -1, executionId: -1 }` and is created during store initialization. Existing data needs no migration; MongoDB creates the index on the next store initialization. CSV export streams all history documents through a cursor in batches of 500, formats the stored execution fields on demand, and does not create a permanent report. The CSV route uses the same LTI session and deployment verification as status. History consumes storage indefinitely until an operator applies normal MongoDB storage policies or capacity constraints; there is no application count limit or TTL.

The summary contains a UUID, `source`, start/completion dates, final status, optional association-level counters, and optional coverage metadata. Duration is calculated from the recorded start and finish times in the page. The UI does not surface coverage or backlog; these persisted values remain available in CSV export. The web process receives no external cron expression/timezone, so next execution is reported unavailable. Summary-write failures are safely logged. Current worker activity comes from the in-process scheduler or shared cron lease. The UI exposes no operation that mutates course offerings.

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

The first successful discovery uses a Mongo baseline lease and marks associations already present as `baseline: true` for audit. Baseline does not suppress reconciliation. Historical and new associations go through the same reconciler; historical work has no new-association stability delay. New associations wait the configured stability duration.

Each run processes at most `SECTION_ASSOCIATION_FIX_MAX_RECONCILIATIONS_PER_RUN` (default 50), in deterministic priority order: stable new/pending work, historical baseline work, then recovery-only blocked retries and due completed verification. Legacy completed records without positive verification evidence become eligible automatically and idempotently. Completed records with evidence are re-read every `SECTION_ASSOCIATION_FIX_COMPLETED_REVERIFY_HOURS` (default 24); any active target is handled by the normal validated update path.

Cron mode runs one bounded fast pass per external invocation and uses persisted `lastRecoveryAt` to keep the four-hour recovery schedule independent. Internal mode runs immediate and recurring timers. Both call the same service functions. The cron lease prevents concurrent cron/worker runs, renews while active, and is awaited on release; expiry is crash recovery.

## Persistence

`section_associations` is keyed by tenant namespace and `associationOrgUnitId`. It stores association code, first/last seen and checked times, status, audit baseline marker, safe errors, compact outcomes, and positive verification evidence. `section_association_meta` stores baseline coordination and cron lease/recovery metadata. Mongo is an operational work ledger; current Brightspace records remain authoritative.

## Transport and write boundary

JWT exchange is shared with the application. Brightspace URLs remain HTTPS on the configured origin; redirects are disabled, request timeouts are bounded, API traffic passes through the shared rate gate, and errors omit credentials. The feature's only write is a narrowly scoped Course Offering PUT.

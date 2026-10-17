# Technical overview

## Components

`index.js` composes the web application, optional LTI provider, and trigger mode. `src/sectionAssociations/runtime.js` builds the OAuth service-account client, Mongo-backed rate-limited transport, store, reconciler, and service; the web and one-shot cron entrypoints share this runtime.

`client.js` contains bounded bookmark pagination and feature-specific API calls. `rules.js` enforces the association code and child suffix patterns. `resolver.js` validates every direct Group child and resolves exact Course Offering codes. `reconciler.js` validates every target before writes, then performs GET → full PUT → verification GET. `store.js` tracks association metadata, positive reconciliation evidence, baseline audit state, and cron lease metadata. `service.js` handles discovery, bounded priority selection, and fast/recovery passes.

The LTI provider is optional during bootstrap. Worker code uses only the Server-to-Server OAuth service account.

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

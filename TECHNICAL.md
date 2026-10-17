# Technical overview

## Components

`index.js` is the web composition root. `src/sectionAssociations/runtime.js` builds the shared service-account OAuth client, Mongo-backed rate-limited HTTP stack, store, and Section Association service; both `index.js` and `scripts/run-section-association.js` use it. The web composition starts the LTI provider and selects cron or internal triggering without duplicating worker logic.

`src/sectionAssociations/client.js` contains bounded bookmark pagination and feature-specific API calls. Its PUT path is restricted to `/d2l/api/lp/{version}/courses/{numericId}`. `rules.js` enforces the exact association-code pattern and group suffix. `resolver.js` validates every child and resolves exact offering codes. `reconciler.js` checks and prepares all target course records before any PUT, then performs fresh GET → full PUT → verification GET. `backfill.js` reuses that resolver, client, and the reconciler's `courseUpdatePayload` helper for explicit historical processing. `store.js` keeps namespaced association metadata and baseline state in dedicated MongoDB collections. `service.js` owns discovery and scheduled passes.

The LTI provider is retained for platform registration, login, and a minimal landing page. No background feature code reads LTI claims or tokens.

## Reconciliation algorithm

1. Read the selected association. Require Course Offering type and code `^\\d{6}-\\d{2}-\\d{4}-I0001$`.
2. Read all bounded child pages. Require at least one child; every child must be Type `Group` and have a code ending in `-\\d{5}`.
3. Remove the final hyphen and five-digit suffix. Reject duplicate derived codes.
4. Resolve every code using `exactOrgUnitCode`. Require one result, a valid ID, Course Offering type, and an ID distinct from the association.
5. GET every target course and validate its current active state and full update payload before starting any write.
6. Leave already-inactive offerings unchanged. In dry-run, report active targets as `would-inactivate`. Otherwise, PUT the full current record with only `IsActive` changed to false, then GET and verify.
7. Mark completed only after every target is confirmed inactive. A blocked validation is `blocked`; transient or uncertain processing remains `pending` for recovery.

The PUT body preserves Name, Code, StartDate, EndDate, LocaleId, ForceLocale, ShowAddressBook, CanSelfRegister, and Description. Brightspace `Description.Text` or `Description.Html` becomes `{Content, Type}` as RichTextInput. Missing or malformed required course data blocks the association before any write.

If a PUT response is lost or otherwise uncertain, the worker performs a read-back. If inactive, it records success. Otherwise it leaves the association pending; a later run begins with current Brightspace reads and does not blindly replay the uncertain request.

## Baseline and scheduling

The first successful discovery obtains a Mongo-backed baseline lease, records all matching associations as baseline records, and performs no writes. The lease prevents concurrent application instances from classifying the same first-run population differently. If baseline persistence fails, its lease is released or allowed to expire and no reconciliation starts.

New records receive `firstSeenAt` and wait ten minutes before processing. In internal trigger mode, fast discovery runs immediately and then every configured interval; the independent recovery timer runs at its configured cadence. In cron mode, each `scripts/run-section-association.js` invocation runs one fast cycle and checks namespaced Mongo scheduler metadata to decide whether recovery is due. `section_association_meta` stores the cron lease and `lastRecoveryAt`; only successful recovery advances that timestamp. Overlapping cron executions contend on an atomic lease and later invocations skip while it is held. Both trigger modes call the same discovery and reconciliation functions. Intervals and stability duration use the documented environment settings.

## Persistence

`section_associations` is keyed by tenant namespace and `associationOrgUnitId`, and stores association code, first/last seen times, last checked time, processed time, status, baseline marker, safe error text, and compact outcome summaries. `section_association_meta` stores the baseline state and temporary lease. MongoDB is a work ledger; it never replaces current Brightspace reads.

## Historical Backfill

The regular service remains baseline-protected: its discovery/reconciliation passes do not make baseline records eligible. `scripts/backfill-section-associations.js` is a separate explicit command that selects only `{namespace, baseline: true}` records in deterministic `firstSeenAt`, `associationOrgUnitId` order. Dry-run is the default; apply requires `--apply` and defaults to 50 records. It validates all resolved targets before any association write, reads current state, and uses the existing `courseUpdatePayload` transformation and client PUT/read-back methods. Uncertain writes are read back and never blindly replayed.

Backfill progress uses only `backfillLastCheckedAt`, `backfillProcessedAt`, `backfillStatus`, `backfillLastError`, and compact `backfillTargets` fields. It does not overwrite baseline or normal `status`/`processedAt` fields. The command shares the worker's Mongo lease to avoid overlapping cron/backfill operations. Each run writes a CSV under `reports/`; reruns inspect live state and skip already-inactive targets. No rollback is implemented.

## Transport and write boundary

Service-account JWT exchange is shared with the existing app. Brightspace URLs must remain HTTPS on the configured origin; redirects are disabled, request timeouts are bounded, API traffic passes through the shared global rate gate, and errors omit credentials. The existing shared client is not made into a general writer; the feature adds one narrowly scoped Course Offering PUT implementation.

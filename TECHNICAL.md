# Technical overview

## Components

`index.js` is the composition root. It validates environment configuration, creates the service-account OAuth client, passes all Brightspace traffic through the existing authenticated GET and Mongo-backed rate-limited HTTP stack, wires the section-association feature, and starts the LTI provider and scheduled service.

`src/sectionAssociations/client.js` contains bounded bookmark pagination and feature-specific API calls. Its PUT path is restricted to `/d2l/api/lp/{version}/courses/{numericId}`. `rules.js` enforces the exact association-code pattern and group suffix. `resolver.js` validates every child and resolves exact offering codes. `reconciler.js` checks and prepares all target course records before any PUT, then performs fresh GET → full PUT → verification GET. `store.js` keeps namespaced association metadata and baseline state in dedicated MongoDB collections. `service.js` owns discovery and scheduled passes.

The LTI provider is retained for platform registration, login, and a minimal landing page. No background feature code reads LTI claims or tokens.

## Reconciliation algorithm

1. Read the selected association. Require Course Offering type and code `^\\d{6}-\\d{2}-\\d{4}-I0001$`.
2. Read all bounded child pages. Require at least two children; every child must be Type `Group` and have a code ending in `-\\d{5}`.
3. Remove the final hyphen and five-digit suffix. Reject duplicate derived codes.
4. Resolve every code using `exactOrgUnitCode`. Require one result, a valid ID, Course Offering type, and an ID distinct from the association.
5. GET every target course and validate its current active state and full update payload before starting any write.
6. Leave already-inactive offerings unchanged. In dry-run, report active targets as `would-inactivate`. Otherwise, PUT the full current record with only `IsActive` changed to false, then GET and verify.
7. Mark completed only after every target is confirmed inactive. A blocked validation is `blocked`; transient or uncertain processing remains `pending` for recovery.

The PUT body preserves Name, Code, StartDate, EndDate, LocaleId, ForceLocale, ShowAddressBook, CanSelfRegister, and Description. Brightspace `Description.Text` or `Description.Html` becomes `{Content, Type}` as RichTextInput. Missing or malformed required course data blocks the association before any write.

If a PUT response is lost or otherwise uncertain, the worker performs a read-back. If inactive, it records success. Otherwise it leaves the association pending; a later run begins with current Brightspace reads and does not blindly replay the uncertain request.

## Baseline and scheduling

The first successful discovery obtains a Mongo-backed baseline lease, records all matching associations as baseline records, and performs no writes. The lease prevents concurrent application instances from classifying the same first-run population differently. If baseline persistence fails, its lease is released or allowed to expire and no reconciliation starts.

Subsequent fast discovery runs every 15 minutes. New records receive `firstSeenAt` and wait ten minutes before processing. The four-hour recovery loop revisits incomplete records through the same discovery and reconciliation functions. Completed items are skipped. Intervals and stability duration can be configured with the documented environment settings.

## Persistence

`section_associations` is keyed by tenant namespace and `associationOrgUnitId`, and stores association code, first/last seen times, last checked time, processed time, status, baseline marker, safe error text, and compact outcome summaries. `section_association_meta` stores the baseline state and temporary lease. MongoDB is a work ledger; it never replaces current Brightspace reads.

## Transport and write boundary

Service-account JWT exchange is shared with the existing app. Brightspace URLs must remain HTTPS on the configured origin; redirects are disabled, request timeouts are bounded, API traffic passes through the shared global rate gate, and errors omit credentials. The existing shared client is not made into a general writer; the feature adds one narrowly scoped Course Offering PUT implementation.

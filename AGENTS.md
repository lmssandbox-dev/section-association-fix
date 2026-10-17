# Project guide

Brightspace Section Association Fix is a Node.js LTI 1.3 service that discovers IPSIS Section Association Course Offerings, resolves their grouped sections to original standalone Course Offerings, and inactivates those originals.

## Architecture

- `index.js` validates web configuration, wires the LTI provider, and selects cron or internal trigger mode. `src/sectionAssociations/runtime.js` wires the shared OAuth service account, rate-limited transport, MongoDB state, and Section Association service for both web and one-shot cron execution.
- `src/shared/` contains Brightspace service-account OAuth, HTTPS/API transport, MongoDB URL validation, and the shared cross-process API rate gate.
- `src/sectionAssociations/` contains discovery rules, exact-code resolution, safe Course Offering updates, persistence, scheduling, and reconciliation.
- `test/section-associations.test.js` covers feature safety rules.

The background worker uses only the OAuth service account. LTI remains a shell for a future protected admin portal and is not required for reconciliation.

## Hosting / Trigger Modes

`SECTION_ASSOCIATION_FIX_TRIGGER_MODE=cron` is the default for sleeping web services. The web service has no in-process recurring timers; configure one Render Cron Job on `*/15 * * * *` with `npm run cron:section-association`. Each one-shot run executes the shared fast cycle and uses Mongo-persisted recovery timing and a cross-process lease to avoid overlapping work. Keep the Render cadence aligned with `SECTION_ASSOCIATION_FIX_FAST_INTERVAL_MINUTES`.

Set the mode to `internal` only for always-on hosting. The web process starts the existing immediate fast tick and recurring fast/recovery timers; no external Cron Job is needed.

Cron → always-on: upgrade the web plan; set mode to `internal`; disable/delete the Cron Job; deploy; verify the mode log, immediate fast cycle, next interval cycle, and recovery timing. Do not reset Mongo state or baseline. Keep the same OAuth credentials, Service User, and reconciliation engine.

Always-on → cron: set mode to `cron`; deploy; create/enable one external Cron Job; retain the same Mongo/OAuth configuration and reconciliation/baseline state.

## Historical Backfill

The recurring worker must continue excluding `baseline: true` records. Historical cleanup is available only through `npm run backfill:section-associations -- --dry-run` or explicit `--apply`; never trigger it at startup or from cron. Dry-run defaults to all baseline associations. Apply defaults to 50 (`--max-associations` controls either mode), and a Mongo worker lease prevents it from overlapping a cron run or another backfill.

Review the CSV in `reports/section-association-backfill-<timestamp>-<run-id>.csv` after every run. Recommended sequence: full dry-run, inspect summary and blocked cases, spot-check ready records, apply batches of 50, review each report, run dry-run again, then investigate any remaining blocked/ready records. Backfill progress belongs only in `backfill*` fields; retain `baseline: true` and all normal worker status fields. Apply must reuse the existing resolver, client and `courseUpdatePayload`, verify every PUT, and never replay an uncertain request. Already-inactive targets are no-ops. There is no rollback implementation.

## Safety rules

- Discover with `orgUnitType=3&orgUnitCode=I0001`, follow every `PagingInfo.Bookmark`, and locally require `^\\d{6}-\\d{2}-\\d{4}-I0001$`.
- A first successful discovery writes a baseline of existing associations and performs no reconciliation. Only later discoveries are eligible.
- Wait at least ten minutes from `firstSeenAt` before reconciliation.
- Reconcile only Course Offerings with matching association codes, at least one direct Group child, valid five-digit child suffixes, and exactly one Course Offering for every derived exact code.
- Finish every association, child, lookup, and current-course validation before the first write.
- The only Brightspace mutation is Course Offering `IsActive: true` to `false`. Immediately before each write, GET the current course, preserve its fields, convert Description to RichTextInput, and PUT the full body. GET again and verify inactive.
- On an uncertain PUT result, read the Course Offering before deciding its outcome. Never replay an uncertain write.
- Dry-run uses the same reconciliation path, reports intended inactivations, and sends no PUT requests.
- State is operational metadata, not proof of Brightspace state. Read current Brightspace records before every update.
- Do not rename offerings, move groups, change enrollments or mappings, or delete records.

## Development

Use Node.js 22. Run `npm test` and `npm run check`. See `README.md`, `TECHNICAL.md`, and `ENVIRONMENT.md` for operations and configuration.

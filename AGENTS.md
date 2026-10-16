# Project guide

Brightspace Section Association cleanup is a Node.js LTI 1.3 service that discovers IPSIS Section Association Course Offerings, resolves their grouped sections to original standalone Course Offerings, and inactivates those originals.

## Architecture

- `index.js` validates configuration, wires the LTI provider, OAuth service account, shared rate-limited transport, MongoDB state, and scheduled loops.
- `src/shared/` contains Brightspace service-account OAuth, HTTPS/API transport, MongoDB URL validation, and the shared cross-process API rate gate.
- `src/sectionAssociations/` contains discovery rules, exact-code resolution, safe Course Offering updates, persistence, scheduling, and reconciliation.
- `test/section-associations.test.js` covers feature safety rules.

The background worker uses only the OAuth service account. LTI remains a shell for a future protected admin portal and is not required for reconciliation.

## Safety rules

- Discover with `orgUnitType=3&orgUnitCode=I0001`, follow every `PagingInfo.Bookmark`, and locally require `^\\d{6}-\\d{2}-\\d{4}-I0001$`.
- A first successful discovery writes a baseline of existing associations and performs no reconciliation. Only later discoveries are eligible.
- Wait at least ten minutes from `firstSeenAt` before reconciliation.
- Reconcile only Course Offerings with matching association codes, at least two direct Group children, valid five-digit child suffixes, and exactly one Course Offering for every derived exact code.
- Finish every association, child, lookup, and current-course validation before the first write.
- The only Brightspace mutation is Course Offering `IsActive: true` to `false`. Immediately before each write, GET the current course, preserve its fields, convert Description to RichTextInput, and PUT the full body. GET again and verify inactive.
- On an uncertain PUT result, read the Course Offering before deciding its outcome. Never replay an uncertain write.
- Dry-run uses the same reconciliation path, reports intended inactivations, and sends no PUT requests.
- State is operational metadata, not proof of Brightspace state. Read current Brightspace records before every update.
- Do not use Data Sets, rename offerings, move groups, change enrollments/mappings, or delete records.

## Development

Use Node.js 22. Run `npm test` and `npm run check`. See `README.md`, `TECHNICAL.md`, and `ENVIRONMENT.md` for operations and configuration.

# Section Association Fix: Administrator's Guide

## What the app does

Brightspace IPSIS can combine several sections into one shared **Section Association Course Offering**. The original standalone Course Offerings may still be active afterward. This app finds those shared offerings, checks which original offerings belong to them, and safely makes those originals inactive when it is allowed to do so.

The app never deletes courses, activates an offering, changes the shared association, moves sections, or changes enrollments. It starts in **dry-run mode**, which checks and records what it would do but sends no course updates.

### Two different kinds of finding

| The app finds… | What it means | How the app looks |
| --- | --- | --- |
| **A new association** | A new shared Course Offering has appeared in Brightspace. | Searches Brightspace's Course Offering list by the association's Org Code pattern and academic period, then compares the returned IDs with its MongoDB records. |
| **A new child section** | An existing shared association now has a different set of child sections. | Opens each selected, already-known association's child list and compares it with that association's last verified snapshot. |

A new association is found by a list search. A child change is found by checking the saved children of one known association at a time. They have different workloads and different detection timing.

**New offering:** Brightspace code search → compare returned IDs with MongoDB → wait if newly found → validate and process.

**Known association:** read its children → compare IDs and Org Codes with the saved list → fully recheck if they differ.

### Terms used in this guide

- **Org Code:** Brightspace's code for a course or section.
- **Academic period:** The year and semester part of a code. `YY01` means January–June; `YY02` means July–December. For example, `2602` means the second half of 2026.
- **Child section:** A Group inside a Section Association Course Offering.
- **Original Course Offering:** The standalone course represented by a child section. The app finds it by deriving its Org Code from the child section's code.
- **Verified snapshot:** The last successfully checked list of child IDs and Org Codes, together with the original offerings they resolve to.

## 1. Finding new Section Associations

During daytime discovery, Brightspace is searched for Course Offerings with either supported Org Code family:

- Legacy codes contain the selected period followed by `-I0001`, for example `002521-01-2602-I0001`.
- PeopleSoft codes begin with `ESPM-` and the selected period, for example `ESPM-2602-GS2-C0011`.

For each selected period, the app searches both code families. These searches return candidate Course Offerings from Brightspace's paginated list. The app checks the results against the tenant's MongoDB records by distinct Brightspace ID. It does not have to open every association individually just to discover which IDs exist. It opens a newly found association later when it performs the full safety check needed to process it.

The optional `SECTION_ASSOCIATION_DISCOVERY_PERIODS` setting controls the period search:

- Unset, empty, or `auto`: previous, current, and next academic periods.
- A value such as `2602` or `2601,2602`: exactly those periods.
- `all`: broad searches across periods once each nightly window, instead of period-specific daytime searches. Ongoing child monitoring still uses the rolling previous/current/next periods.

Discovery can only find an offering that Brightspace successfully created. A wider period search cannot repair an IPSIS import that failed before creating the offering.

When an ID is new, MongoDB records it for processing. The app normally waits **10 minutes** from first seeing it before full reconciliation, giving Brightspace time to finish setting it up. A historical association found by the broad nightly scan does not use this new-record waiting period.

Full reconciliation then reads the association and its direct Group children. Each child code must have a valid section ending, such as `-01125`; removing that final hyphen and five-digit suffix gives the expected original Course Offering code. Every expected code must resolve to exactly one Course Offering. The app reads and validates the complete target set before making any update. If a course is missing, ambiguous, or structurally invalid, that association is blocked from changes and the problem is recorded. The app does not partially update a set of originals.

## 2. Watching for child changes in existing associations

After a successful full reconciliation, MongoDB keeps a verified snapshot containing the association ID, its child section IDs and Org Codes, and the corresponding original Course Offering IDs and Org Codes. A completed dry run can save this snapshot only when fresh reads confirm that every original is already inactive. If any original is still active in dry-run mode, the association remains pending and has no completed verified mapping yet.

A child check must ask Brightspace for the children of each selected known association. A search for new association Org Codes cannot answer whether a particular existing association gained or lost a child. The child check reuses the response it fetched and compares the current list with the saved snapshot:

- **Added:** a child ID is in the current list but not the snapshot.
- **Removed:** a child ID is in the snapshot but not the current list.
- **Org Code changed:** the same child ID is present, but its Org Code differs.

The check compares IDs and Org Codes, not just the number of children. It sorts the lists before comparing them, so a different response order does not count as a change. An unchanged hourly inspection does not create a child-change audit record.

A difference requests full reconciliation. The app reads the current association and children again, resolves every original Course Offering by its current exact Org Code, and validates every target before any update. A saved mapping or a detected difference alone never authorizes a change. Removing a child never causes the app to reactivate an original offering.

If there is no trusted verified snapshot, the app does not guess what was added or removed. It sends that association through full reconciliation to build a trustworthy mapping when possible. Initial discovery and baseline recording do not create Child Changes CSV rows because there is no earlier verified child list to compare.

## 3. Daily schedule and manual runs

Times below are São Paulo local time. In the normal Render setup, one cron job starts an opportunity every 15 minutes, all day. The worker gates each activity to its window:

| Time | What happens |
| --- | --- |
| **07:00–23:00** | Period-scoped association discovery and daytime child monitoring have 15-minute cron opportunities. |
| **23:00–01:00** | One broad historical discovery window. If a scan fails, later cron starts in the same window can retry it. A successful scan before midnight prevents a duplicate after midnight. |
| **01:00–07:00** | Saved original Course Offering IDs are checked at :00 and :30, from 01:00 through 06:30. These quick checks do not authorize updates; suspicious results go through full fresh reconciliation. |
| **All day** | Pending and blocked work can be processed. Recovery is normally due every four hours. |

The daytime period search scope and the rolling monitoring scope are related but different. An explicit discovery setting controls which periods are searched for new associations. Child monitoring covers the previous, current, and next periods; with an explicit list, it checks only the periods from that list that are in the rolling window. `all` runs broad discovery nightly, while child monitoring remains rolling.

**Run Now** starts a manual execution and fresh period-scoped discovery at any hour. With `all`, `auto`, or no configured scope, it searches the previous/current/next periods. It does not launch a broad historical scan just because it was requested manually. It does not force daytime child checks or nighttime saved-ID checks outside their normal windows. The usual 10-minute wait, reconciliation cap, safety checks, and dry-run setting still apply.

An always-on `internal` setup uses the same service and maintenance windows, with a 15-minute fast interval by default. It should not run alongside the external cron job.

## 4. Monitoring capacity and possible delays

The daytime child-inspection batch defaults to **125 associations per eligible run**. An administrator can lower or raise that ceiling with `SECTION_ASSOCIATION_FIX_CHILD_MONITOR_BATCH_SIZE`. The worker also has a shared limit of 50 full reconciliations per scheduled invocation; a detected change can wait if that capacity has already been used.

There are four scheduled 15-minute opportunities in an hour. This gives the following theoretical child-inspection capacities:

| Batch per run | Runs per hour | Theoretical inspections per hour |
| ---: | ---: | ---: |
| 125 | 4 | 500 |
| 160 | 4 | 640 |

For **604 known associations**, a batch of 125 cannot inspect all 604 in four runs: its theoretical capacity is 500, leaving at least 104 due for later selection. A batch of 160 has theoretical capacity for 640, enough for 604 if all four runs can use the full batch and no other limits or failures interfere.

These are capacity calculations, not time guarantees. The worker selects associations due for the current hourly window, starts with the oldest successful inspection, and applies a one-hour cooldown after an inspection attempt so one recent failure does not get retried every 15 minutes. The dashboard backlog count does not subtract those cooldown records. Selection order, earlier work, API errors, and the 50-reconciliation cap can all delay inspection or follow-up work.

### Example: a child added just after its check

- At **10:05**, the app successfully inspects an association.
- At **10:06**, IPSIS adds a child section.
- That association has already been checked in the 10:00 hourly window, so the new child is not necessarily checked again during that hour.
- It can be selected in a later hourly window once the one-hour attempt cooldown has also passed. Since cron starts every 15 minutes, a check at 10:05 is not eligible at 11:00; 11:15 is the first scheduled opportunity after its cooldown, assuming batch capacity is available.
- Once the difference is detected, the app may reconcile it in the same run if a full-reconciliation slot remains. Otherwise the change stays pending and a later run can reconcile it.

So the time the app **detects** a child change and the time it **completes** reconciliation are separate. A child added just after inspection may be detected much later than a new association found by the 15-minute list search. The source does not guarantee a maximum such as 60, 75, or 120 minutes.

## 5. Understanding the monitoring numbers

Open an Execution History row to see details for work that ran. The numbers describe different activities:

| Dashboard label | What it counts |
| --- | --- |
| **Child checks** | Successful child-list reads divided by attempted child-list reads, such as `121/125`. This is lightweight monitoring, not full reconciliation. |
| **Changes detected** | Associations whose child list differed or had an unexpected child type. It counts associations, not individual changed sections. Child Changes CSV has a separate row for each changed child. |
| **Mapping refreshes** | Associations that need full reconciliation to confirm or refresh the child-to-original-course mapping. It is not a count of courses to deactivate. An untrusted or missing saved mapping can also require a refresh. |
| **Monitoring backlog** | Completed associations in the monitored periods whose last successful child inspection is before the current hourly window, or has never succeeded. It is not an error count or a count of required deactivations. Recent attempts in the one-hour cooldown can remain in this count while being temporarily left out of selection. |
| **Checked** | Associations that received a full reconciliation attempt. A lightweight child check does not increase this number. |
| **Corrections** | Associations with at least one original Course Offering update that was read back and verified as inactive. It counts associations, not target courses. Already-inactive courses add no correction. |
| **Errors** | Failed or blocked reconciliation outcomes and known execution-level failures. Child monitoring read errors are tracked separately as monitoring errors when shown. |
| **Historical backlog** | Older baseline associations still needing their first successful full reconciliation or verified mapping. This is different from the routine child-monitoring backlog. |

For example, suppose **604** completed associations are due at 09:00. A 125-item run successfully inspects 125, so those records move out of that hour's due count. More 15-minute runs can inspect more of the remaining set. With only 500 theoretical checks in the hour, some can remain due. When the 10:00 window begins, records successfully inspected during the 09:00 hour are old enough to become due again; the oldest uninspected work is selected first. The backlog can therefore fall during an hour and rise again when a new hourly window begins.

A run can show **Child checks: 0/0** and still show a nonzero backlog. For example, associations may be due by the hourly timestamp but still be within the one-hour attempt cooldown, so the worker leaves them out of that run's selection while the backlog count continues to include them.

## 6. Example: what the app changes

Suppose the shared association is `ESPM-2602-GS2-C0011` and it has two child sections:

| Child section | Derived original Course Offering |
| --- | --- |
| `ESPM-2602-GS2-S51H-01125` | `ESPM-2602-GS2-S51H` |
| `ESPM-2602-GS2-S52H-01139` | `ESPM-2602-GS2-S52H` |

IPSIS adds a third child, `ESPM-2602-GS2-S53H-01140`, which maps to `ESPM-2602-GS2-S53H`. The child check detects the new child, then full reconciliation checks the whole current association and all three corresponding original Course Offerings before making any update.

1. **The third original is active:** If every target is found exactly once and passes validation, live mode can make active originals inactive and then verify each result. Dry-run reports the intended action and sends no update.
2. **The third original is already inactive:** The app leaves it alone. Reconciliation can complete with no correction, and Corrections CSV has no row for that offering. Child Changes CSV still records the added section.
3. **The third original is missing or ambiguous:** Validation fails for the association. The app makes no partial updates to any of its three originals and records an exception for investigation.

The app only changes original Course Offerings from active to inactive after successful validation. It never activates one, and it never changes the association's child structure.

## 7. Reports and what they mean

Open a row in Execution History and choose **Reports** to download the reports for that execution. Older executions without detailed audit coverage show that detailed reports are unavailable.

- **Corrections CSV:** Course Offering changes that were verified by reading Brightspace after the update. Already-inactive offerings do not create correction rows.
- **Exceptions CSV:** Associations that were blocked or failed, with the available reason. It also includes confirmed-missing lifecycle records.
- **Child Changes CSV:** Genuine child additions, removals, and Org Code changes compared with a previous verified snapshot. An added child is reported even if its original Course Offering was already inactive.

A detection and its eventual outcome can appear as separate rows. The execution that first sees the change owns the detection row, marked pending/deferred. If a later run reconciles the association, that run adds an outcome row linked to the original detection. The earlier detection row is not rewritten. The outcome says whether reconciliation completed without a correction, completed with a verified correction, or was blocked/failed. A missing or untrusted previous snapshot does not produce a guessed before-and-after change.

## 8. Staying safe and getting help

The app checks the association and every target before making any updates. The only possible Brightspace change is setting an original Course Offering to inactive, followed by a read-back check. If any target cannot be resolved or validated, the app stops before partial changes. Uncertain updates are checked before the app decides what happened; they are never blindly repeated.

The LTI monitoring page shows Service Status, Execution History, API Health Check, and administrator-only Run Now. Start with Execution History when investigating a problem. Open the Exceptions CSV for blocked/failed work and the Child Changes CSV for changes to an existing association's structure. A completed run means that run ended; it does not mean every association has already been checked.

**In short:** the app searches for new shared offerings, separately checks known shared offerings for section changes, validates their original courses, and inactivates only safe targets when live processing is enabled. It keeps reports so administrators can see what it found and what happened next.

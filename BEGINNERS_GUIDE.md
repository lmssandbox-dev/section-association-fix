# Beginner's Guide

## What the application does

When Brightspace combines course sections, it creates a shared **Section Association Course Offering**. The original standalone offerings can remain active, so students or staff may see duplicate courses. This application finds the shared offering, checks which original offerings belong to it, and inactivates eligible originals.

The application does not delete courses or change the shared association. It validates the full relationship before making any update. Dry-run is the default and sends no course updates.

## How new associations are detected

During the day, the app searches Brightspace for new association offerings every five minutes. When it first sees an offering, it records the time and waits five minutes before processing it. Later searches do not restart that wait.

After the wait, the app checks the association and its child sections, finds the matching original course offerings, and validates all of them. When updates are enabled, it makes eligible originals inactive and reads them again to confirm the change. An original is not deactivated when the relationship is missing, ambiguous, or unsafe. A historical association found by the nightly scan does not use the new-association wait.

## How new sections are detected

The app already knows many association offerings. Every five minutes during the day, it inspects up to 320 of them, starting with the ones that have gone longest without inspection. After a successful inspection, an offering can be selected again as soon as it comes around in the rotation; there is no fixed waiting period. Once all known offerings have been inspected, the cycle continues automatically. For each offering, the app reads its direct child sections and compares their IDs and Org Codes with the saved verified list. It detects added sections, removed sections, and Org Code changes. A failed read is temporarily delayed for 15 minutes, then returns to the rotation.

The default batch is **320 association offerings inspected** per eligible run. It does not mean 320 individual child sections: one association offering may have several child sections. With 604 eligible offerings, the first run can inspect 320, and the next can inspect the remaining 284 plus 36 of the oldest offerings already inspected. The rotation then continues. With 800 offerings, it takes more runs to inspect the full population; the oldest-first order keeps the cycle moving across the whole population. The time for a complete pass depends on how many eligible offerings exist and on failures or available API capacity. Detected changes are saved until the full safety checks and reconciliation can process them.

## What timing to expect

Under normal conditions, allow about **5–10 minutes** for discovery of a new association and for the next inspection to detect an incremental child change. These are operating targets, not guaranteed service levels. Processing time, Brightspace availability, API limits, failed reads, or a large backlog can make detection or deactivation take longer. Detection and completed deactivation are separate steps.

The full-reconciliation limit is 50 associations per run. The worker reserves capacity for newly eligible associations and detected child changes, then uses available slots for routine work. If a change cannot be reconciled in that run, it stays recorded and is retried later.

## Daytime and nighttime schedule

Times below use São Paulo local time. The external Render job wakes the app every five minutes, and the app decides which work is due:

| Time | What the app does |
| --- | --- |
| **07:00–23:00** | Searches for new associations in the configured periods and rotates through known associations to inspect child sections. |
| **23:00–01:00** | Runs the broad historical search once for the nightly window. If it fails, later five-minute starts can retry it. |
| **01:00–07:00** | Checks saved original-course IDs every 30 minutes. These quick checks cannot authorize a course update; anything suspicious gets a fresh full validation. |
| **Recovery, all day** | Pending and blocked work remains eligible. The existing recovery schedule checks every four hours, including outside daytime hours. |

The nightly search and 30-minute checks keep their existing schedules even though Render wakes every five minutes. The LTI **Run Now** action performs period discovery immediately, but does not force child monitoring outside its daytime window.

**Render administrator action:** change the existing Cron Job schedule to `*/5 * * * *` and keep the command `npm run cron:section-association`. This is an external Render setting; changing application environment variables does not change the Cron Job schedule. Internal mode also defaults to a five-minute fast interval and is only for always-on hosting.

## Safety and API limits

The app waits five minutes so Brightspace has time to finish creating an association. Before an update, it checks that each child is a valid Group and that every matching original offering is unique and correct. It respects the shared Brightspace API limits, validates all targets before changing any of them, and reads back each update to confirm it worked. The only update is changing an eligible original Course Offering from active to inactive.

The dashboard history labels this count **Associations inspected** and shows successful/attempted association offerings, how many changes were found, how many reconciliations completed, and how many detected changes remain deferred. Its backlog counts offerings that have never had a successful inspection or have gone more than ten minutes since one, while leaving failed reads out until their 15-minute retry delay expires. This ten-minute coverage measure does not delay successful offerings from entering the rotation again. The inspection count is not a count of individual child sections.

For a simple example, if association `ESPM-2602-GS2-C0011` gains a child section, the next inspection compares it with the saved list. The app records the addition, rechecks the whole association and all matching originals, then inactivates only safe active originals in live mode. If any required original is missing or ambiguous, no partial update is made.

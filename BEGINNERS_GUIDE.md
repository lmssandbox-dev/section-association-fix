# Section Association Fix
## A simple guide to what the app does

**In one sentence:** The app finds the original Brightspace courses that have been combined into a shared course and safely makes those originals inactive, so learners and instructors use the right course.

You don't need to know programming to use this guide. You only need a basic understanding of courses and sections in Brightspace.

---

## 1. Why do we need this app?

Sometimes an institution combines several class sections into **one shared course** through IPSIS. Brightspace calls this a *Section Association*.

For example:

**Before** — three separate courses are active:

- Marketing — Section 01
- Marketing — Section 02
- Marketing — Section 03

**After** — the sections belong to one shared Marketing course. But the three original courses might still be active.

**The app's job:** identify those original courses and make them inactive **after checking that it is safe**.

The shared course stays active. Nothing is deleted. The app does not change enrollments or move sections.

---

## 2. What are the main parts?

| Part | What it means in everyday language |
| --- | --- |
| **Brightspace** | Where the real courses and sections live. |
| **The app** | Finds associations, checks the original courses, and decides whether to make them inactive. |
| **Automatic scheduler** | Wakes up every 15 minutes to see which tasks should run. |
| **MongoDB** | The app's notebook: what it found, checked, changed, or couldn't finish. |
| **Monitoring page (LTI)** | A read-only dashboard showing whether the app is working and what happened in previous runs. |

**The big picture**

```text
Brightspace courses and sections
             |
             v
      Section Association Fix
       |                 |
       v                 v
 Checks and safe      Records history
 course updates       in MongoDB
       |
       v
  Brightspace

A scheduler starts the work; the LTI page shows the results.
```

The app works in the background even if nobody opens the monitoring page.

---

## 3. How does it handle a new association?

Here is the process in five steps:

**1. Find it.** The app notices a newly created shared course that matches the supported Section Association formats.

**2. Give it time.** A new association normally waits **at least 10 minutes**, so Brightspace can finish setting it up.

**3. Check the sections.** The app identifies every original course represented by the association's sections.

**4. Check everything before changing anything.** If a course is missing, ambiguous, or does not match the expected structure, the app stops that association and records the problem. It does not make a partial set of changes.

**5. Act and confirm.** If all checks pass and live processing is enabled, the app makes active originals inactive, then checks the result. Already-inactive courses are left alone.

```text
New shared course found
          |
          v
Wait at least 10 minutes
          |
          v
Check sections and original courses
          |
     Are checks OK?
       /      \
      No      Yes
      |        |
 Record issue  Make originals inactive*
      |        |
 Try again     Confirm and record result
 when eligible

* Only in live mode. In dry-run mode, the app reports
  what it would do but does not change Brightspace.
```

**Important:** The app starts in **dry-run mode by default**. In this mode, it can find and check courses, but **it does not inactivate anything**. Live mode must be enabled for actual course changes.

---

## 4. What does the app do throughout the day?

The scheduler starts the app **every 15 minutes**, including overnight. That does **not** mean every course is checked every 15 minutes. Different kinds of work happen at different times, and courses are checked in batches.

All times below are **São Paulo local time**.

| When | Main activity | Why it matters |
| --- | --- | --- |
| **07:00–23:00** | **Find new associations and check known associations for section changes** | Detects new shared courses and added, removed, or changed sections. |
| **23:00–01:00** | **Search older academic periods** | The broad search runs once in this nightly window. The window crosses midnight: after a successful search before midnight, its saved window date prevents a duplicate search after midnight. Failed attempts can retry on later 15-minute cron runs until 01:00. |
| **01:00–07:00** | **Check saved original-course IDs** | Checks run every 30 minutes at :00 and :30 (01:00 through 06:30). Unexpected results trigger fresh safety checks before any possible update. |
| **All other overnight cron ticks** | **Pending and recovery work** | The 15-minute scheduler still processes eligible pending work and recovery between lightweight monitoring slots. |
| **All day** | **Process eligible pending work and recover from problems** | Keeps unfinished work moving. Recovery is normally due about every four hours. |

### A typical day, at a glance

```text
23:00          01:00                   07:00                23:00
|--------------|-----------------------|--------------------|
 Broad historical  Cached-ID checks at     New + known association
 scan window       :00 and :30 only        discovery + child checks

The Render Cron Job starts every 15 minutes throughout the day. Cached-ID verification uses only every other cron slot, so it runs every 30 minutes; skipped slots still allow pending and recovery work. Its default batch ceiling is 150 associations per eligible run and can be adjusted with `SECTION_ASSOCIATION_FIX_STATUS_VERIFY_BATCH_SIZE`. Twelve eligible runs give a theoretical ceiling of 1,800 associations per night at the default batch size. This is a maximum calculation, not a promise that every association will be checked: rate limits, errors, queued work, and available API capacity affect actual throughput.

Pending work and recovery may be handled at any hour.
The scheduler starts a run every 15 minutes.
```

The daytime search normally covers the **previous, current, and next academic periods**, unless configured differently. The nightly historical search is broader.

The app processes a limited number of associations per run to control workload. If there is more work than fits in one run, the rest can be picked up later. **There is no guaranteed 15-minute response time for every course.**

---

## 5. What if something changes later?

**A new section is added to a shared course.** During daytime monitoring, the app can notice the difference. It rechecks the association and the original courses before making any new inactivation.

**A section is removed.** The app rechecks the relationship, but it **does not reactivate** an original course automatically.

**An original course is already inactive.** Nothing needs changing. The app records that it was already in the expected state.

**Brightspace temporarily returns an error.** The app records the issue and can try again later. It does not assume a failed lookup means a course has been deleted.

**An association seems to have disappeared.** The app does not decide it is missing after just one failed lookup. It waits at least **30 minutes** and requires a newer successful search that also cannot find that exact association. The record stays in the app's history.

**An old association is discovered.** The daily historical search helps bring it into the workflow. Historical baseline records do not need the 10-minute waiting period used for new associations.

---

## 6. What keeps the process safe?

The app is intentionally cautious:

- **Check first, change second.** Every original course must be identified correctly before the app changes any of them.
- **Only original courses are inactivated.** The shared course is not inactivated, and no course is deleted.
- **No automatic reactivation.** The app never turns an inactive original back on.
- **Confirm the result.** After an update, the app reads the course again to verify its status.
- **Don't trust old notes alone.** MongoDB helps the app remember what happened, but the app must check current Brightspace information before changing a course.
- **Dry-run is the default.** No Brightspace courses are updated until live processing is enabled.

**What the app cannot do:** It cannot create a Section Association, fix an IPSIS import that never created a course in Brightspace, or correct section/enrollment mappings.

---

## 7. How can I see what happened?

The LTI monitoring page is available to authorized users and is **read-only**. It does not have a button to inactivate courses.

| Area | What to look for |
| --- | --- |
| **Service Status** | Is the worker running or idle? What academic periods are configured? What happened most recently? |
| **Execution History** | What happened in each run? How many associations were checked, already correct, changed, or affected by problems? |
| **API Health Check** | Are the Brightspace API versions and available health information showing any concerns? This check does not change courses. |
| **Corrections report** | Which course inactivations were successfully verified? |
| **Exceptions report** | Which associations had problems, and why? |

**A completed run** means that particular run finished. It does **not** mean every association in Brightspace has been checked.

**A failed run** means that run did not finish normally. **A skipped run** often means another worker was already doing the job.

If something looks wrong, start with **Execution History** and then open the **Exceptions report**, if available. Some older executions do not have detailed reports.

---

## 8. The essentials to remember

- **Purpose:** keep old standalone courses from remaining active after their sections are combined into a shared course.
- **Starting frequency:** every **15 minutes**, but each type of work has its own hours and capacity limits.
- **Daytime (07:00–23:00):** find associations and watch for section changes.
- **Late night (23:00–01:00):** search historical periods once per nightly window. Crossing midnight does not start a second broad search because completion is tied to the window that began at 23:00.
- **Overnight (01:00–07:00):** check previously identified original courses every 30 minutes, at :00 and :30.
- **Scheduler cadence:** Render starts the worker every 15 minutes; cached-ID checks run on alternate slots, while pending/recovery work remains eligible on all slots and outside monitoring windows.
- **Nightly check capacity:** up to 150 cached associations per eligible run by default, configurable with `SECTION_ASSOCIATION_FIX_STATUS_VERIFY_BATCH_SIZE`. Capacity is a ceiling and cannot guarantee that all queued associations are checked each night.
- **Always eligible:** processing due pending work and recovery from problems.
- **New associations:** normally wait at least **10 minutes** before being processed.
- **Safety first:** the app checks the current association before making changes, and it never deletes courses.
- **Default setting:** **dry-run** — checks only, no actual course inactivation.

**Bottom line:** The app helps keep Brightspace course access organized after Section Associations are created. It finds the original courses, checks them carefully, inactivates them only when allowed and safe, and keeps a record of what happened.

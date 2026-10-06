# Badge program

The weekly badge program (serpcompany/best.serp.co#59, #66) checks every week that the listings
which rely on the badge still show it, and confirms a missing badge about 24 hours later before
anything happens (`apps/web/lib/badge-program/`, D1 side in
`packages/data-ops/src/badge-program.ts`, run by `apps/web/lib/worker/scheduled.ts`).

## Switching it on

It runs only while `features.badgeProgram` (`apps/web/lib/features.ts`) is on. While it is off,
each trigger's job returns `{ enabled: false }` without reading D1 or fetching any site. The
owner turns it on at launch, after #65's `/account/listings/<slug>/` pages are live: the
`badge-missing` and `listing-unlisted` emails link there, and the email audit
(`links.test.ts`) fails until they exist. A local Worker can run it with the flag off
(`LOCAL_PREVIEW_VARS=LOCAL_BADGE_PROGRAM=on`; ignored unless `SITE_ENVIRONMENT` and
`D1_RUNTIME_ENV` are both `local`), which `apps/e2e/tests/badge-program.spec.ts` uses with
`/__scheduled?cron=<expression>` against fixture sites.

## How it works

- **Who.** A live listing submitted by someone else (`source = 'submission'`) whose approved
  submission is on the free plan (a paid listing refunded but kept as free counts), and a listing
  whose current owner claimed it with the badge (`verified_via = 'badge_claim'`, #67). Never an
  admin listing without a badge claim, and never a paid one. The owner needs an email address,
  because every miss is warned first.
- **The check** is the submit flow's verifier (`badge-verifier.ts`): the page must link the
  badge to the listing with a plain followed link. A **conclusive miss** is a loaded page whose
  badge is missing, not followed (`nofollow`, `sponsored`, `ugc`, or robots rules for all crawlers
  or Googlebot), or links elsewhere (`CONCLUSIVE_VERIFICATION_FAILURES`). Everything else (timeout,
  unreachable, any HTTP error status, non-HTML or unreadable page, the parser's limits) is
  **inconclusive**: recorded, never a miss.
- **Triggers** (UTC, `apps/web/lib/badge-program/schedule.ts`): weekly
  `15 3 * * 1` opens a cycle, daily `45 3 * * *` opens a confirmation window, and the hourly
  `0 * * * *` continues both. Each run sends again failed program emails that still apply, then
  rechecks due warnings, then checks listings due this cycle: at most 20 sites per run, 4 at a
  time, so a run stays far below the Workers subrequest (1,000) and CPU limits whatever the
  catalog size, and about 3,000 listings fit in a week of hourly runs. A Queue was not needed: the
  cursor is the data (a listing with a check since the cycle started is done), so batches need no
  extra state, infrastructure, or ordering. Raise `BADGE_CHECK_LIMIT` or the hourly cadence
  before the program outgrows that.
- **State machine** (`badge_checks.kind` is `weekly` or `confirmation`):
  1. *Due*: no check of any kind since the cycle started. The weekly check records `pass`,
     inconclusive `fail`, or conclusive `fail`.
  2. *Warning*: the latest conclusive check is a weekly miss from the last 7 days. The owner gets
     `badge-missing`, which names the recheck: the first daily window at least 20 hours later
     (about 24 hours). The weekly pass skips the listing meanwhile.
  3. *Recheck*: once per daily window. A pass ends the warning; an inconclusive result is
     recorded and retried the next day; a conclusive miss is **confirmed**. A warning older than
     a week lapses, and the next weekly check starts over.
  4. *Confirmed*, in the same D1 batch as the recheck row: a free submitted listing is
     **unpublished** with the `listing-unpublish` plan (reason `badge_missing`, actor
     `badge-program`, activity log, publication run, version bump; its URL answers 410) and the
     owner gets `listing-unlisted`; there is no automatic restore (paying, #68, is the way back).
     A badge-claimed listing **loses its owner** (`badge_removed`; the listing stays up as
     curated) and the former owner gets `ownership-removed`. A lost publication race is retried
     once; otherwise nothing is recorded and the next run rechecks.
- **Idempotency.** Every write is a compare-and-swap on that state, and each email goes through
  the email ledger under `<template>:<check id>`, so a replayed or overlapping trigger never
  records a check, unpublishes, or emails twice. Writing a check never moves the catalog epoch;
  only the unpublish or revocation does.
- **Visibility.** The admin listing page shows the history; `/account` (#65) shows it to the
  owner. An owner's own "Verify badge" or "Re-verify now" never writes `badge_checks` (an
  architecture guard keeps the program the only writer), so it can neither open nor end a warning.

## Checking it on staging

After a deploy, the Worker's Settings → Triggers list `0 * * * *`, `15 3 * * 1`, and
`45 3 * * *`. Each run logs `scheduled_job_finished` with `job: "badge-program"` and either
`enabled: false` or its counts (`weekly`, `warned`, `confirmations`, `unpublished`, `revoked`,
`inconclusive`, `skipped`, `more`). A listing with `source = 'admin'` and no badge claim never
gets a `badge_checks` row:

```sql
SELECT COUNT(*) FROM badge_checks b JOIN listings l ON l.id = b.listing_id
WHERE l.source = 'admin' AND NOT EXISTS (SELECT 1 FROM listing_owners o
  WHERE o.listing_id = l.id AND o.verified_via = 'badge_claim');
```

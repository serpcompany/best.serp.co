# Badge program

The weekly badge program (serpcompany/best.serp.co#59, #66) checks every week that the listings
which rely on the badge still show it, and confirms a missing badge about 24 hours later before
anything happens (`apps/web/lib/badge-program/`, D1 side in
`packages/data-ops/src/badge-program.ts`, run by `apps/web/lib/worker/scheduled.ts`).

## Switching it on

It runs only while `features.badgeProgram` (`apps/web/lib/features.ts`) is on. **It is on**
since #130 (the owner's launch decision, 2026-10-07): each trigger's job reads D1 and checks
sites, and logs its counts instead of `{ enabled: false }`. The approved wording that promises
weekly checks shows with it (`apps/web/lib/feature-copy.ts`): the free plan's "Keep the badge
up: we check it every week", the badge step's "Keep the badge up" card, the account's "Badge
checks" card ("Free listings are checked weekly") and badge panel ("Free listing · checked
weekly", "Fix the badge before the recheck"), the claim dialog's badge card and "Keep the badge"
alert, and the `listing-approved` email ("We check it every week, and a free listing whose
badge goes missing is removed."). The program's own emails (`badge-missing`, `listing-unlisted`,
`ownership-removed`) are now sent.

Its emails link to #65's `/account/listings/<slug>/`, and offer what later issues build only
while their flags are on: the paid upgrade and "Relist" (#68) with `features.orders`, and
claiming again (#67, by badge or payment) with `features.claims` and `features.orders`. Orders
are on since #133, so all of these offers are sent: `badge-missing` adds "Rather not keep the
badge? Upgrade to a paid listing for $49 one-off…", `listing-unlisted` offers "Relist for $49",
and `ownership-removed` offers to claim it again. The email audit (`links.test.ts`) fails if a
badge email offers either while its flag is off. The account's "unlisted" status says "Removed
after a confirmed badge miss. Relisting is paid." (with orders off, "Removed from
best.serp.co.").

Turning the flag off again makes each job return `{ enabled: false }` without reading D1 or
fetching any site, and takes the weekly-check copy out. A local Worker can still run the
program with the flag off (`LOCAL_PREVIEW_VARS=LOCAL_BADGE_PROGRAM=on`; ignored unless
`SITE_ENVIRONMENT` and `D1_RUNTIME_ENV` are both `local`). No suite needs it while the flag is
on: `apps/e2e/tests/badge-program.spec.ts` runs `/__scheduled?cron=<expression>` against
fixture sites on the site's flags.

## How it works

- **Who.** A live listing submitted by someone else (`source = 'submission'`) whose approved
  submission is on the free plan (a paid listing refunded but kept as free counts), and a listing
  whose current owner claimed it with the badge (`verified_via = 'badge_claim'`, #67). Never an
  admin listing without a badge claim, and never a paid one. The owner needs an email address,
  because every miss is warned first: the current owner, or for a listing approved before
  ownership rows, its submitter, unless an admin removed that submitter as owner (such a listing
  has nobody to warn and stays out). A free listing whose own submission is in review
  (`paid_pending_review` or `changes_requested`) waits for that decision, because unpublishing
  is refused meanwhile; it is not fetched again every hour.
- **The page checked** is a submitted listing's website, or for a badge claimer the product page
  recorded with their claim (`listing_claims.product_url`, [Claims](./CLAIMS.md)): an imported
  listing's website is usually a `serp.ly` link, whose page never shows the badge.
- **The check** is the submit flow's verifier (`badge-verifier.ts`): the page must link the
  badge to the listing with a plain followed link. A **conclusive miss** is a loaded page whose
  badge is missing, not followed (`nofollow`, `sponsored`, `ugc`, or robots rules for all crawlers
  or Googlebot), or links elsewhere (`CONCLUSIVE_VERIFICATION_FAILURES`), and **any 4xx** (a
  `403` to our checker, a dead `404` or `410`; owner decision, 2026-10-06). Everything else
  (timeout, unreachable, 5xx, non-HTML or unreadable page, the parser's limits) is
  **inconclusive**: recorded, never a miss.
- **The finding** in `badge-missing` is literally true: "marked **nofollow**" only when the
  link's `rel` has `nofollow`. A `sponsored` or `ugc` link (or a resent email, whose tokens are no
  longer known), a robots-blocked page, and a 4xx reuse the submit page's approved lines for the
  same results: "Badge found, but the link isn’t followed.", "Badge found, but the page tells
  search engines not to follow links.", and "The site answered with HTTP <status>.". For a 4xx
  the email says the check "couldn’t reach" the site (the submit page's "We couldn’t reach
  <site>") instead of "loaded", and gives the submit page's advice for that result, "Make sure
  the page is public and that a firewall or bot protection isn’t blocking our checker.", instead
  of asking to put the badge back. 
- **Triggers** (UTC, `apps/web/lib/badge-program/schedule.ts`): weekly
  `15 3 * * 1` opens a cycle, daily `45 3 * * *` opens a confirmation window, and the hourly
  `0 * * * *` continues both. Each run sends again failed program emails that still apply, then
  rechecks due warnings, then checks listings due this cycle: at most 20 sites per run, 4 at a
  time, so a run stays far below the Workers subrequest (1,000) and CPU limits whatever the
  catalog size, and about 3,000 listings fit in a week of hourly runs. A Queue was not needed: the
  cursor is the data (a listing with a check since the cycle started is done), so batches need no
  extra state, infrastructure, or ordering. Raise `BADGE_CHECK_LIMIT` or the hourly cadence
  before the program outgrows that.
- **State machine** (`badge_checks.kind` is `weekly` or `confirmation`; `refund` is below):
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

## The check at refund (#68)

When a paid listing is refunded, its badge is checked once, right then, and the refund decides on
that check alone (owner decision, 2026-10-06; #106 review round 2): `checkBadgeAtRefund`
(`apps/web/lib/badge-program/refund.ts`) checks the listing's website and records the result as
`kind = 'refund'`, the only `badge_checks` write outside the weekly program. #68 passes its
`checkId` to `buildRefundSubmissionPlans` within `REFUND_BADGE_CHECK_MAX_AGE_HOURS` (one hour; a
retried refund checks again):

- `keepFree: true` (a pass): `keep_free` keeps the listing up as free, and the weekly program then
  checks it. The plan refuses unless that check is the listing's latest refund check and passed.
- `keepFree: false` (a miss, a 4xx, or a result that can't tell): `unpublish` takes it down. The
  plan refuses unless that check did not pass, so an earlier weekly pass can neither keep the
  listing nor block the refund.

The admin Orders refund calls it ([Billing](./BILLING.md)).

## Checking it on staging

After a deploy, the Worker's Settings → Triggers list `0 * * * *`, `15 3 * * 1`, and
`45 3 * * *`. Each run logs `scheduled_job_finished` with `job: "badge-program"`,
`enabled: true` (`false` only if the flag is turned off), and its counts (`weekly`, `warned`,
`confirmations`, `unpublished`, `revoked`, `inconclusive`, `skipped`, `more`). A listing with `source = 'admin'` and no badge claim never
gets a weekly or confirmation check (expect 0), and the second query counts the live free
submitted listings outside the program because nobody can be warned (no current owner with an
address, and no submitter fallback):

```sql
SELECT COUNT(*) FROM badge_checks b JOIN listings l ON l.id = b.listing_id
WHERE b.kind <> 'refund' AND l.source = 'admin' AND NOT EXISTS (SELECT 1 FROM listing_owners o
  WHERE o.listing_id = l.id AND o.verified_via = 'badge_claim');

SELECT COUNT(*) FROM listings l
JOIN listing_submissions s ON s.listing_id = l.id AND s.status = 'approved' AND s.plan = 'free'
WHERE l.source = 'submission' AND l.status = 'approved' AND l.is_active = 1
  AND NOT EXISTS (SELECT 1 FROM listing_owners o JOIN users u ON u.id = o.user_id
    WHERE o.listing_id = l.id AND o.role = 'owner' AND o.revoked_at IS NULL)
  AND (s.owner_user_id IS NULL OR EXISTS (SELECT 1 FROM listing_owners r
    WHERE r.listing_id = l.id AND r.user_id = s.owner_user_id AND r.revoked_at IS NOT NULL));
```

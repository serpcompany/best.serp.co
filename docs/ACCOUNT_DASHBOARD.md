# Submitter dashboard

`/account` (serpcompany/best.serp.co#65) is where a signed-in submitter follows their
submissions and manages the listings they own. The screens follow the mockups approved in #70
(screens 5 to 7 and the dashboard-01 shell, `components/account/account-shell.tsx`, which the
admin panel shares through `@/components/dashboard/*`). `features.accountDashboard`
(`apps/web/src/lib/features.ts`) is on, so emails and the submit pages use its approved wording and
links ([Email templates](./EMAIL_TEMPLATES.md#routes-the-buttons-need)).

| Screen | Route |
|---|---|
| Overview: section cards, the table, the status legend | `/account/` |
| The same table, submissions only or listings only | `/account/submissions/`, `/account/listings/` |
| Badge panel of a free listing (a Drawer over the listings) | `/account/listings/<slug>/` |
| Submission (screen 6) | `/account/submissions/<id>/` |
| Live listing edit (screen 7) | `/account/listings/<slug>/edit/` |

The table merges both kinds of record: every submission except an approved one (its listing is
the row), and every listing the user owns, except one whose own submission is still in review
(that submission is the row). Tabs: All, Needs action (a draft, a pending badge, changes
requested, or a revision with changes requested), Live, Closed (rejected, withdrawn, unlisted).
A draft or a pending-badge submission continues in the submit flow (`/submit/<id>/…`); its
`/account/submissions/<id>/` redirects there. Messages (#73) and Settings show "Soon"; the
user menu holds the email and sign-out.

## Ownership and requests

Every read and write is scoped to the session's user in SQL (`packages/data-ops/src/account.ts`):
a submission by `owner_user_id`, a listing by a current `listing_owners` row, a revision by
`author_user_id`. Someone else's id reads as missing, so pages and requests answer 404. Pages
call `requireAccountUser()` (`lib/account/pages.ts`: signed out, `/login` and back). Writes are
route handlers, never Server Actions, under `POST /api/account/`; each calls
`authorizeUserRequest()` (the session, and an `Origin` among the trusted origins: the CSRF check
of #60 and #64), reads a JSON body of at most 32 KB, and answers JSON with `no-store`. The
architecture guard requires both calls and keeps SQL out of `lib/account/`.

| Endpoint | Body | Does |
|---|---|---|
| `submissions/<id>/withdraw` | none | `draft`, `pending_badge`, `verified`, `changes_requested`, never once paid or live (#59) |
| `submissions/<id>/resubmit` | details, optional `faqs` and `resourceLinks`, `expectedContentVersion` | the owner's edit plus `resubmit`, one batch; FAQs and links are replaced when sent, else kept |
| `submissions/<id>/extras` | `faqs`, `resourceLinks`, `expectedContentVersion` | FAQs and links while `verified` or `paid_pending_review` |
| `listings/<id>/revision` | details, `faqs`, `resourceLinks`, `expectedRevisionVersion` | a new revision, or the open one replaced (and resubmitted after a change request) |
| `listings/<id>/discard-revision` | none | withdraws the open revision |
| `listings/<id>/verify-badge` | none | checks a live free listing's badge (below) |

A changed logo is checked as on `/submit/` (https, then a fetch that confirms the image); an
unchanged one is kept as stored, so an imported listing's site-relative logo survives an edit.
Links must be https. At most five FAQs and five links (`ACCOUNT_LIMITS`). Name and website never
change here. Every save carries the version its form loaded (`expectedContentVersion`, or
`expectedRevisionVersion`: the open revision's, or null for the live listing), and the plans
compare and swap on it, so a stale tab gets 409 and never overwrites newer edits. Edits spend
their own budget (`lib/account/limits.ts`: 10 a minute, 60 an hour per account), apart from the
submit flow's draft saves, and only once the request is valid: a refused or stale save costs
nothing.

A resubmission and a revision entering the queue send `admin-review-ready` to the admin
recipient (keyed by the item and its content version), whatever the listing's plan (an owner an
admin assigned reads "None"); its button opens `/admin/revisions/<id>/` for a revision. Revision
decisions send nothing to the owner yet: there
is no approved template.

## FAQs and links in review

The owner adds FAQs and links to a submission waiting for review ("Add them now and they're
reviewed with the listing", screen 6): `ownerExtras` in `submission-plans.ts` replaces only the
staged FAQs and links and increments `content_version`, so an approval of the older content is
refused (409) and the reviewer reloads. Name, descriptions, category, and logo stay locked in
the queue (`ownerEdit` is unchanged). Approved FAQs show on the listing page in an FAQs
section (#105), so `features.listingFaqs` is on and the FAQ fields say "Shown on your listing
page."; off, they say "FAQs will appear on your listing page soon." (`feature-copy.test.ts`).
Links render as resource links.

## Badge panel

For a live free listing (its approved, unpaid submission with `plan = 'free'`), the Drawer shows
the last check, its result, the embed code, and the history, and "Re-verify now" runs the badge
step's verifier (#84): one compare-and-swap claim on the submission (`listingBadgeCheck`, the
30-second cooldown, and the panel's own budget of ten checks that find a result per listing in
the last 24 hours, so it refills and never depends on the badge step's lifetime ten; connection
problems never count), then the outbound budget per submission, account, and client address.
The checks are events with the actor `account-badge-check`, stamped with the check's time. The button
is disabled while a check runs and through the cooldown (the owner decision for the badge step),
with no "too many checks" copy. The owner's checks are recorded on the submission
(`last_verification_at` and `badge_verified` / `verification_failed` events), never in `badge_checks`, which stays the
badge program's (#66) history, so a manual miss can't start #66's recheck or count toward the
refund window. The history merges both, marked "You" or the program's label. With
`features.badgeProgram` on (#130), the panel says "Free listing · checked weekly", a failing
badge reads "Fix the badge before the recheck" with "If it’s still failing at the recheck about
24 hours later, the listing is unlisted.", the program's checks are labelled "Weekly", and the
overview's "Badge checks" card says "Free listings are checked weekly" (`feature-copy.ts`; off,
none of it promises weekly checks). The "Upgrade: $49 one-off" entry point (in the badge panel)
and an unlisted listing's "Relist for $49" show only while orders are on, as they are since #133
([Billing](./BILLING.md)), and a draft's next step reads "Choose free or paid".

## Logos

The dashboard shows logos through the submit flow's `ProductLogo` (no referrer, lazy), as #84's
account table did: account pages are private and noindex. When self-hosted media (#95, PR #96)
lands, a revision's changed logo should be hosted on save the way #96 hosts a submission's
(`hostSubmissionMedia`), and the account reads should return the hosted key.

## Tests

`packages/data-ops/src/account.test.ts` (node:sqlite), the plan tests in `submission-plans.test.ts`,
`scripts/d1-workerd-plans.test.ts` (every plan and read on Wrangler-local D1),
`apps/web/src/lib/account/*.test.ts`, and `apps/e2e/tests/account-dashboard.spec.ts` (Playwright on
its own local Worker and empty D1, `PLAYWRIGHT_PORT` + 5, like the admin suite's +3, since both
publish listings and add admins: the statuses, FAQs in review, edit and resubmit, approval, the
badge panel, a revision an admin approves, withdraw, and ownership). Set
`ACCOUNT_SCREENSHOT_DIRECTORY` to capture every screen at both widths in both themes.

# Submitter dashboard

`/account` (serpcompany/best.serp.co#65) is where a signed-in submitter follows their
submissions and manages the listings they own. The screens follow the mockups approved in #70
(screens 5 to 7 and the dashboard-01 shell, `components/account/account-shell.tsx`, which the
admin panel shares through `@serpdirectory/web-core/dashboard/*`). `features.accountDashboard`
(`apps/web/lib/features.ts`) is on, so emails and the submit pages use its approved wording and
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
| `submissions/<id>/resubmit` | details, `expectedContentVersion` | the owner's edit plus `resubmit`, one batch; FAQs and links are kept |
| `submissions/<id>/extras` | `faqs`, `resourceLinks`, `expectedContentVersion` | FAQs and links while `verified` or `paid_pending_review` |
| `listings/<id>/revision` | details, `faqs`, `resourceLinks` | a new revision, or the open one replaced (and resubmitted after a change request) |
| `listings/<id>/discard-revision` | none | withdraws the open revision |
| `listings/<id>/verify-badge` | none | checks a live free listing's badge (below) |

A changed logo is checked as on `/submit/` (https, then a fetch that confirms the image); an
unchanged one is kept as stored, so an imported listing's site-relative logo survives an edit.
Links must be https. At most five FAQs and five links (`ACCOUNT_LIMITS`). Edits count against
the submit flow's 10 saves an hour per account. Name and website never change here.

A resubmission and a revision entering the queue send `admin-review-ready` to the admin
recipient (keyed by the item and its content version); its button opens
`/admin/revisions/<id>/` for a revision. Revision decisions send nothing to the owner yet: there
is no approved template.

## FAQs and links in review

The owner adds FAQs and links to a submission waiting for review ("Add them now and they're
reviewed with the listing", screen 6): `ownerExtras` in `submission-plans.ts` replaces only the
staged FAQs and links and increments `content_version`, so an approval of the older content is
refused (409) and the reviewer reloads. Name, descriptions, category, and logo stay locked in
the queue (`ownerEdit` is unchanged). The public listing page does not render listing FAQs yet;
links render as resource links.

## Badge panel

For a live free listing (its approved, unpaid submission with `plan = 'free'`), the Drawer shows
the last check, its result, the embed code, and the history, and "Re-verify now" runs the badge
step's verifier (#84) with its rules: one compare-and-swap claim on the submission
(`listingBadgeCheck`, 30-second cooldown, ten checks that find a result, connection problems
never count), then the outbound budget per submission, account, and client address. The button
is disabled while a check runs and through the cooldown (the owner decision for the badge step),
with no "too many checks" copy. The owner's checks are recorded on the submission (its counters
and `badge_verified` / `verification_failed` events), never in `badge_checks`, which stays the
badge program's (#66) history, so a manual miss can't start #66's recheck or count toward the
refund window. The history merges both, marked "You" or the program's label. Until
`features.badgeProgram` is on, nothing promises weekly checks (`feature-copy.ts`), and the
"Upgrade: $49 one-off" entry point stays hidden with `showPaidListings` (#68).

## Logos

The dashboard shows logos through the submit flow's `ProductLogo` (no referrer, lazy), as #84's
account table did: account pages are private and noindex. When self-hosted media (#95, PR #96)
lands, a revision's changed logo should be hosted on save the way #96 hosts a submission's
(`hostSubmissionMedia`), and the account reads should return the hosted key.

## Tests

`packages/data-ops/src/account.test.ts` (node:sqlite), the plan tests in
`submission-plans.test.ts`, `scripts/d1-workerd-plans.test.ts` (every plan and read on
Wrangler-local D1), `apps/web/lib/account/*.test.ts`, and `apps/e2e/tests/account-dashboard.spec.ts`
(Playwright on the admin suite's Worker and D1: the statuses, FAQs in review, edit and resubmit,
approval, the badge panel, a revision an admin approves, withdraw, and ownership). Set
`ACCOUNT_SCREENSHOT_DIRECTORY` to capture every screen at both widths in both themes.

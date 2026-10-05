# Submission flow

## Statuses and transitions

Native submissions (serpcompany/best.serp.co#59) move through these statuses in
`listing_submissions.status`. Every transition is a compare-and-swap statement plan in
`packages/data-ops/src/submission-plans.ts` (`submissionTransitions`), tested for every source
status in `submission-plans.test.ts`; see [Data model](./DATA_MODEL.md#statement-plans).

| Status | Meaning | Live | Review queue |
| --- | --- | --- | --- |
| `draft` | Saved from the form; no plan chosen, or paid chosen and checkout not completed | no | no |
| `pending_badge` | Free chosen; the badge is not verified yet | no | no |
| `verified` | Waiting for review: free with a verified badge, or paid with a failed guardrail check | no | yes |
| `paid_pending_review` | Paid and the guardrail checks passed: live, and waiting for review | yes | yes |
| `changes_requested` | A reviewer asked for edits (`reviewer_note`) | if it was | no |
| `approved` | Accepted; its listing was published | yes | no |
| `rejected` | Refused with `rejection_reason` and `rejection_category` | no | no |
| `withdrawn` | Withdrawn by its owner, expired, or cleared by an admin (`withdrawal_reason`) | no | no |

| Transition | From | To |
| --- | --- | --- |
| choose free | `draft` | `pending_badge` (`plan = 'free'`) |
| choose paid | `draft` | `draft` (`plan = 'paid'`, awaiting checkout) |
| badge verified | `pending_badge` | `verified` |
| payment, checks passed | `draft` with `plan = 'paid'`, `pending_badge`, or free `verified` | `paid_pending_review`; the listing is published |
| payment, a check failed | the same | `verified` with `plan = 'paid'` |
| payment after withdrawal | `withdrawn`, unpaid | unchanged; payment and full refund recorded together |
| upgrade | `approved`, free, live | unchanged; `plan = 'paid'` |
| approve | `verified` | `approved`; the listing is created and published |
| approve | `paid_pending_review` | `approved`; its staged content replaces the live listing's |
| request changes | `verified`, `paid_pending_review` | `changes_requested` |
| resubmit | `changes_requested` | `paid_pending_review` when it has a listing (still live), otherwise `verified` |
| withdraw (owner) | `draft`, `pending_badge`, `verified`, `changes_requested`, unpaid and not live | `withdrawn` (`owner`) |
| clear draft (admin) | `draft` | `withdrawn` (`admin`) |
| expire (system) | `draft` saved 30 days ago or more | `withdrawn` (`expired`, event `expired`) |
| reject | `pending_badge`, `verified`, `paid_pending_review`, `changes_requested` | `rejected` |
| edit (owner) | `draft`, `pending_badge`, `changes_requested` | unchanged (`edited`, `content_version` + 1) |
| edit (reviewer) | any non-final status | unchanged (`edited`, `content_version` + 1) |

- Drafts never enter the review queue, are never badge-checked, and trigger no badge or review
  email. Like every non-final status, a draft holds its URL key against duplicates (the
  `listing_submissions_active_slug_idx` partial unique index).
- Drafts expire (#59 owner decisions, `draft-plans.ts`). The clock is `draft_saved_at`, the
  first save; edits never reset it. Reminders are due 12 hours, 48 hours, 7, 14, and 21 days
  after it, in two variants: `choose_plan` (no plan chosen; CTA "Choose a plan") and
  `complete_checkout` (paid chosen, not paid; CTA "Complete checkout"). They stop on payment,
  choosing free (`pending_badge`), withdrawal, or expiry; a run that missed some sends only the
  latest one due. At 30 days every draft is withdrawn as `expired`, including a paid draft that
  never completed checkout, which frees its URL, and gets the "draft expired" email; an expired
  draft cannot choose a plan. The scheduled job (#63) reads `selectDraftRemindersDuePlan` (which
  returns the `variant`) and `selectExpiredDraftsPlan`, claims each reminder with
  `buildMarkDraftReminderSentPlans` for that variant (a compare-and-swap, so a reminder is claimed
  once and matches the current state), and then sends through the email ledger with
  `draftReminderEmailKey` or `draftExpiredEmailKey` as the idempotency key.
- An approved submission creates its listing with `source = 'submission'` and a `nofollow`
  outbound link, and makes the signed-in submitter its owner (`verified_via = 'submission'`).
- Approvals compare and swap on the `content_version` the reviewer saw. The live approval also
  requires the listing to be unchanged since it was published (`published_checksum`). While a
  listing's own submission is in review (`paid_pending_review` or `changes_requested`) it has no
  other edit channel: revisions are refused and unpublishing is refused (reject it instead).
- Payment races: a draft that switched to free while its checkout was open is upgraded by the
  payment from `pending_badge`; a payment that completes after withdrawal or expiry is recorded
  with its refund (#68's webhook issues it). Any other charge the submission cannot accept lives
  only in #68's `orders`, which is the ledger of record ([Data model](./DATA_MODEL.md)). Once
  paid, the owner cannot withdraw; they message the team (#73) and an admin decides.
- The protected publisher's `listing-unpublish` can still take a listing down while its
  submission is queued (an emergency takedown is never blocked). The in-app plans refuse that,
  but after such a takedown a `changes_requested` submission cannot be resubmitted and a
  `paid_pending_review` one cannot be approved; the admin resolves it by rejecting with `live`,
  which records no second unpublish.
- Rejecting a submission with a listing (pass `live` whenever `listing_id` is set) unpublishes
  it (410) if it is still up and revokes the submitter's ownership in the same batch. A
  `prohibited` rejection blocks the registrable domain and its subdomains (or the exact host,
  for a public suffix such as `github.io`) from new free and paid submissions until an admin lifts
  the block; an `other` rejection may be submitted again as a new submission.
- Refunds (`buildRefundSubmissionPlans`) record `refunded_at`: after an `other` rejection (never
  a `prohibited` one); for an approved paid listing whose latest conclusive badge check passed in
  the last 7 days, which stays live with `plan = 'free'` (the event records that check); by
  unpublishing a live listing without such a pass; or, for a listing already down, without
  touching the catalog.
- Events (`listing_submission_events`): `created`, `plan_chosen`, `verification_failed`,
  `badge_verified`, `paid`, `edited`, `changes_requested`, `resubmitted`, `approved`,
  `rejected`, `withdrawn`, `expired`, `refunded`, `unpublished`.
- Owners edit a live listing through a revision (`listing_revisions`): `pending_review`,
  `changes_requested`, then `approved` (applied atomically to the listing), `rejected`, or
  `withdrawn` (`revision-plans.ts`).

## Review in the admin panel (#64)

Admins decide in `/admin` ([Admin panel](./ADMIN_PANEL.md)). The review queue lists
`verified` and `paid_pending_review` submissions and `pending_review` revisions, oldest first.
On a submission an admin can approve (optionally editing the name, category, short and long
description, and logo first, and choosing the outbound link; the edit and the approval are one
batch), request changes with a note, or reject with a reason and a category; on a rejected
prohibited URL, "Allow resubmission" lifts the block. Each decision is these plans with the
`content_version` guard, is idempotent (a replay answers `replayed: true` and sends nothing),
records the admin's email in the events, and emails the submitter once ("approved", "changes
requested", "rejected", or "rejected: prohibited"). Rejecting a paid submission as `other`
waits for #68's refund. These decisions write production D1 directly: the documented
production-write exception ([Admin panel](./ADMIN_PANEL.md#the-production-write-exception)).

## Legacy capability flow (until #63 and #69)

The admin panel replaces the protected approver below for decisions; the notifier and the
private preview keep working until the legacy flow is retired.

The public `/submit/` page lists active categories from D1. Its form posts to
`POST /api/submissions`, which writes the submission, resource links, FAQs, and a
creation event to D1 staging tables and returns an opaque capability token (only its
SHA-256 digest is stored). These rows start at `pending_badge` with the free plan. The
page keeps the capability in browser storage and a URL fragment so the submitter can
resume later.

The submitter installs a "Featured on SERP" badge and selects **Verify installed
badge**. `POST /api/submissions/<id>/verify` authenticates the capability, enforces a
10-attempt limit and a 30-second cooldown, and fetches the submitted website. It
succeeds only when the badge image links to the future listing URL without
`nofollow`. Success moves the row to `verified`; it does not publish anything.
Badges embedded before the URL simplification link to `/products/<slug>/reviews/`; that
URL redirects to the listing and is still accepted.

Transient failures (connection, timeout, HTTP status, redirects, non-HTML) update the
last-check time but do not consume an attempt; conclusive HTML results
(`badge_missing`, `nofollow`, `wrong_destination`) do.

A notifier (`scripts/d1-submission-notifier.ts`) reads verified rows with no
notification entry, opens an assigned issue in this private repository, and stores its
number, URL, and a digest of a one-time draft-preview capability. The reviewer opens
the private preview link (`/admin/submissions/<id>/preview/<token>/`, uncached and
noindex; like every `/admin` page it also needs an admin session and, in production,
Cloudflare Access: [Accounts](./ACCOUNTS.md)) and then approves or rejects with
`scripts/d1-submission-approver.ts` from a protected workflow. Approval atomically promotes the staged data into the catalog and
advances the publication version; either decision revokes the preview link.

Both steps run against production D1 only:

- `notify-d1-submissions.yml` runs `pnpm db:notify:production` every 15 minutes in the
  `production-notifier` environment. It stays off until the repository variable
  `SUBMISSION_REVIEWER_GITHUB_LOGIN` names the reviewer, and it skips until that environment
  holds `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`.
- `approve-d1-submission.yml` ("Review D1 Submission") is dispatched from `main` with the
  submission UUID, `approve` or `reject`, and the confirmation
  `approve-best.serp.co-submission-production`. After reviewer approval of the `production`
  environment, it exports a D1 backup (an Actions artifact kept 30 days), runs
  `pnpm db:approve:production`, and comments on and closes the review issue.

Setup and guards are in [the deploy runbook](./DEPLOY_RUNBOOK.md#workflows).

Code: `packages/web-core/src/forms/d1-submission-form.tsx`,
`apps/web/lib/submissions/`, `packages/data-ops/src/submissions.ts`, and
`packages/data-ops/src/submission-plans.ts`.

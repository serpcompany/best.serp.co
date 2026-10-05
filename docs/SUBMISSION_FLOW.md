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
| `withdrawn` | Withdrawn by its owner | no | no |

| Transition | From | To |
| --- | --- | --- |
| choose free | `draft` | `pending_badge` (`plan = 'free'`) |
| choose paid | `draft` | `draft` (`plan = 'paid'`, awaiting checkout) |
| badge verified | `pending_badge` | `verified` |
| payment, checks passed | `draft` with `plan = 'paid'` | `paid_pending_review`; the listing is published |
| payment, a check failed | `draft` with `plan = 'paid'` | `verified` |
| approve | `verified` | `approved`; the listing is created and published |
| approve | `paid_pending_review` | `approved`; its staged content replaces the live listing's |
| request changes | `verified`, `paid_pending_review` | `changes_requested` |
| resubmit | `changes_requested` | `paid_pending_review` if live, otherwise `verified` |
| withdraw | `draft`, `pending_badge`, `verified`, `changes_requested`, unpaid and not live | `withdrawn` |
| reject | `pending_badge`, `verified`, `paid_pending_review`, `changes_requested` | `rejected` |
| edit staged content | `draft` to `changes_requested` (any non-final status) | unchanged (`edited` event) |

- Drafts never enter the review queue, are never badge-checked, and trigger no badge or review
  email. Like every non-final status, a draft holds its URL key against duplicates (the
  `listing_submissions_active_slug_idx` partial unique index).
- An approved submission creates its listing with `source = 'submission'` and a `nofollow`
  outbound link, and makes the signed-in submitter its owner (`verified_via = 'submission'`).
- Rejecting a live submission unpublishes its listing (410) and revokes the submitter's
  ownership in the same batch. A `prohibited` rejection blocks the URL key from new free and
  paid submissions until an admin lifts the block; an `other` rejection may be submitted again
  as a new submission.
- Refunds (`buildRefundSubmissionPlans`) record `refunded_at`: after a rejection; for an
  approved paid listing whose latest conclusive badge check passed, which stays live with
  `plan = 'free'`; or otherwise by unpublishing the listing.
- Events (`listing_submission_events`): `created`, `plan_chosen`, `verification_failed`,
  `badge_verified`, `paid`, `edited`, `changes_requested`, `resubmitted`, `approved`,
  `rejected`, `withdrawn`, `refunded`, `unpublished`.
- Owners edit a live listing through a revision (`listing_revisions`): `pending_review`,
  `changes_requested`, then `approved` (applied atomically to the listing), `rejected`, or
  `withdrawn` (`revision-plans.ts`).

## Legacy capability flow (until #63 and #69)

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

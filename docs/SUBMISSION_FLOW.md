# Submission flow

The public `/submit/` page lists active categories from D1. Its form posts to
`POST /api/submissions`, which writes the submission, resource links, FAQs, and a
creation event to D1 staging tables and returns an opaque capability token (only its
SHA-256 digest is stored). The page keeps the capability in browser storage and a URL
fragment so the submitter can resume later.

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
noindex) and then approves or rejects with `scripts/d1-submission-approver.ts` from a
protected workflow. Approval atomically promotes the staged data into the catalog and
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

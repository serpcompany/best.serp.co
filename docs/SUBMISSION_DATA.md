# Submission and ownership data

The private side of the data model: submissions, listing owners, owner revisions, badge checks,
and the payment fields. Column meanings and most constraints are commented in
`apps/web/src/db/schema.ts`; this page holds the invariants that span columns or tables, and why.
Statuses and transitions are in [Submission flow](./SUBMISSION_FLOW.md), claims in
[Claims](./CLAIMS.md#data), and orders in [Billing](./BILLING.md#data).

## Ownership

`listing_owners` allows one current owner per listing (a partial unique index). Revoking keeps
the row, so the table is the ownership history. User references are `ON DELETE RESTRICT`:
account deletion must resolve ownership first.

## Submissions

- `plan` is the plan the submitter chose (`free` | `paid`), null while a draft has not chosen
  one. A refund that keeps a listing live because its refund badge check passed
  (`badge_checks.kind = 'refund'`, the check the refund names) sets the plan to `free`.
- CHECK constraints tie the review record together. A refund never coexists with a `prohibited`
  rejection; a withdrawn row never holds an unrefunded payment (the owner cannot withdraw once
  paid); and a draft is native (it has an owner and a block key) and unpaid (no `paid_at` or
  `listing_id`), with no plan or `paid` chosen, never `free`.
- `content_version` (submissions and revisions) increments on every content edit; approvals
  compare and swap on the version the reviewer saw. `published_checksum` is the listing
  checksum written when a paid submission went live before review; the live approval requires
  the listing to still have it, so an admin edit made meanwhile is never overwritten.
- The column defaults are still the legacy free flow (`status = 'pending_badge'`,
  `plan = 'free'`), so intake writes a draft explicitly: `status = 'draft'`, `plan = NULL` (the
  default `free` is refused for a draft), `owner_user_id`, `draft_saved_at`
  (`Date#toISOString()`), and `block_key` with `block_covers_subdomains` from `urlKey()`.
- **Draft clock.** `draft_saved_at` starts when the draft is first saved. Edits never reset it or
  the reminders (owner decision, 2026-10-06: the 30 days run from the first save), so editing
  cannot extend a hold on a URL. The schedule is in
  [Submission flow](./SUBMISSION_FLOW.md#draft-reminders-and-expiry).

## URL keys and prohibited URLs

`urlKey()` (`apps/web/src/lib/url-key.ts`) normalizes every website once. The host is the slug
and the duplicate key: a website is already listed when a listing's slug is its host, or a
listing's stored website is one of its spellings (`websiteSpellings()`). Intake and the admin
website edit share that rule (`listingWebsiteMatch`), and the stored website stays as entered.
Comparing stored websites by host needs a stored key (serpcompany/best.serp.co#94, open),
because most imported slugs aren't hosts.

`block_key` is the host's registrable domain per the Public Suffix List, private section
included, so `user.github.io` is its own site. The app computes it at intake and stores it with
its scope (`block_covers_subdomains`), because SQLite cannot evaluate the PSL; CHECKs keep it
equal to the slug or a parent domain of it. A host with no registrable domain (a public suffix
such as `github.io`, or an IP address) is its own block key with an exact-host scope, so a block
on it never covers the separate sites under it.

A `prohibited` rejection inserts an active block for the block key with that scope; the trigger
`listing_submissions_refuse_blocked_url` then refuses any new submission, free or paid, whose
slug is the blocked key, or a subdomain of it when the block covers subdomains, until an admin
lifts the block (`lifted_at`). `other` rejections block nothing.

**Limitation:** a row written before block keys existed has none, so a prohibited rejection of
it blocks its exact host only. Such rows exist only on staging (production had no submissions
then), so there is no backfill.

## Payments and refunds

- **Charges are recorded in `orders`** ([Billing](./BILLING.md)), the ledger of record for every
  charge and refund. `paid_at` and `refunded_at` describe a payment applied to this submission,
  nothing more; a charge the submission can't accept (a duplicate checkout, a payment after a
  withdrawal, rejection, or change request) is refunded from `orders` alone.
- **Refund pending.** A paid submission rejected as `other` owes its refund from the rejection
  batch on. The batch writes that marker atomically (`status = 'rejected'`,
  `rejection_category = 'other'`, `paid_at` set, `refunded_at` null), so no extra column is
  needed; recording the refund clears it. The refund hook is idempotent and is retried by a
  replayed rejection and by its sweep ([Admin panel](./ADMIN_PANEL.md#refunds)).

## Revisions and badge checks

- `listing_revisions` stage an owner's edit of a live listing (never its website or slug) against
  the listing's `checksum` at the time (`base_checksum`). A listing has at most one open
  revision, and none while its own submission is still in review, because that submission is
  then its only edit channel. The logo is required, like a submission's.
- `badge_checks` is the badge program history, written only by
  `apps/web/src/db/badge-program.ts` ([Badge program](./BADGE_PROGRAM.md)). Writing it never
  changes the catalog epoch. An owner's own checks are recorded on the submission
  ([Submitter dashboard](./ACCOUNT_DASHBOARD.md#badge-panel)).
- `orders` and `billing_events` are written only by `apps/web/src/db/billing.ts`.

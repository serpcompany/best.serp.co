# D1 data model

The schema is modeled once in `packages/data-ops/src/schema.ts`. `pnpm db:generate`
(`drizzle-kit generate`) writes reviewable SQL into `d1/drizzle/`, and Wrangler applies
it while recording the `d1_migrations` ledger. Every D1 binding in
`apps/web/wrangler.jsonc` (local, staging, production) declares the same `DB` binding,
`migrations_dir`, and `migrations_table: "d1_migrations"`; the local config check and the
release script refuse a binding that drifts. `drizzle-kit push` is not an approved
migration path.

Local, staging, and production are separate databases with the same schema and migration
history. A migration is applied locally (`pnpm db:migrate:local`), then to staging by
Deploy Staging, then to production by Deploy Production only after Deploy Staging verified
that commit (see [Release guards](./RELEASE_GUARDS.md#staging-before-production)).

Local data is a documented exception to the standard's "seeded fake/fixture data" rule
(owner decision a, serpcompany/best.serp.co#42). Local D1 is seeded with the real public
catalog from the committed import. That data is public and pinned, contains no submissions
or other user data, and the parity checks and Playwright suites need it. Submissions and any
future user data are seeded from fixtures only, never copied from staging or production.

`d1/drizzle/0000_baseline.sql` is hand-finished after generation: every table is
`STRICT`, `PRAGMA foreign_keys = ON` leads the file, and four triggers enforce that a
published listing always has exactly one primary category. Keep those properties when
adding migrations (later migrations end each `CREATE TABLE` with `STRICT` by hand too);
Drizzle cannot express them. `0002_better_auth.sql` also seeds the admin allowlist with a
fixed `created_at`, so bootstrap parity stays exact.

`0003_submissions_data_model.sql` (serpcompany/best.serp.co#62) is hand-finished in two more
ways, because D1 enforces foreign keys and runs a migration in one transaction, where
`PRAGMA foreign_keys=OFF` has no effect:

- `listings` only gains columns (`ALTER TABLE ... ADD ... CHECK`). Drizzle generates a
  rebuild for a new CHECK; dropping `listings` would cascade-delete its memberships, media,
  links, and FAQs and drop the primary-category triggers. Never rebuild `listings`.
- `listing_submissions` and its four child tables are rebuilt as `__new_*` tables that
  reference the new parent; the old children are dropped before the old parent, so no drop
  cascades, and the renames carry the references over. Copy that order for any future rebuild
  of a referenced table, and recreate its triggers.

A test applies the migration to a populated database inside a transaction with foreign keys
enforced (`scripts/d1-drizzle-local.test.ts`). After `pnpm db:generate`, replace the generated
SQL with the hand-finished form and check that a second `pnpm db:generate` reports no changes.

D1 has limits that `node:sqlite` does not apply: LIKE and GLOB patterns of at most 50 bytes, at
most 100 bound parameters and 100,000 bytes per statement, and at most 32 arguments per
function; Wrangler-local D1 (workerd) also allows only 5 terms per compound SELECT and an
expression depth of 100, but does not enforce the function limit. So (serpcompany/best.serp.co#77):

- No CHECK or trigger uses LIKE or GLOB (ISO instants are checked with
  `x IS strftime('%Y-%m-%dT%H:%M:%fZ', x)`), and no statement binds user input into a pattern.
  The architecture guard fails on a bound or concatenated LIKE/GLOB pattern, a literal pattern
  over 50 bytes, or a function with more than 32 arguments, in data-ops, scripts, and migrations.
- `packages/data-ops/src/sql-limits.ts` checks every statement the SQLite and workerd test
  helpers run against those limits, and against a column compared with itself (#78).
- `scripts/d1-workerd-plans.test.ts` runs the #62 plans on workerd, and
  `scripts/d1-workerd-queries.test.ts` runs every catalog, search, account, email, and
  submission operation on workerd with the full import and worst-case inputs, with a
  rows-read budget per catalog query shape (both in harness step "D1 contracts").
- Search matches a listing's name, short description, slug (the product's domain), and active
  category slugs and names, never its long content or website URL (nearly all are `serp.ly`
  affiliate links). The query is cut to 100 characters
  and 8 distinct terms (truncated, never rejected); ASCII letters fold like SQLite's `lower()`
  and other characters match as typed. The terms are one JSON binding read with `json_extract`,
  matched with `instr()`, so a search binds four values whatever its length. Results are
  cached per epoch, and `limit` is at most 100.
- `0004_query_indexes.sql` adds `listings(display_order)` (the next display order of a new
  listing), `listings(website)` (the submission duplicate check), and full indexes on the
  foreign keys of `listing_owners`, `listing_revisions`, and `listing_submission_url_blocks`
  (their partial indexes cannot serve SQLite's foreign-key checks). It drops two indexes that
  duplicated a unique index and two no query used.

- `categories` stores taxonomy rows and display order (unique `slug`).
- `listings` stores public product fields, status, publication time, and stable IDs
  (unique `slug`), plus `source` and `link_rel` (see [Listings](#listings-source-link-and-unpublishing)).
- `listing_categories` stores ordered category membership with one primary category.
- `listing_media`, `listing_resource_links`, and `listing_faqs` store detail content.
- `publication_state` is a single row (`id = 1`) with the current version and checksum.
- `migration_runs` and `publication_runs` record imports and applied manifests.
- `listing_slug_redirects` maps retired slugs to their listing.
- `listing_submissions` and its resource, FAQ, event, rate-limit, and notification
  tables hold private intake, owned by the signed-in submitter (#63). `access_token_hash` is
  retired: nothing reads or writes it, and a follow-up migration drops it once no live Worker
  uses it.
  `listing_submission_url_blocks` holds prohibited-URL blocks.
- `listing_owners`, `listing_revisions` (with resource, FAQ, and event tables), and
  `badge_checks` hold ownership, owner edits, and badge program history (#62, below).
- `listing_events` is the listing activity log (#64): admin edits, unpublish (with the note),
  republish, link changes, and ownership grants, revocations, and transfers, each with its
  actor, written by the plan that makes the change (`listing-plans.ts`).
- `email_deliveries` is the transactional email ledger: one row per template and event key
  (status, attempts, provider message id, error code), never a recipient or content
  (see [Email](./EMAIL.md)). Each sign-in code send prunes `sign-in-code` rows older than 24
  hours ([Accounts](./ACCOUNTS.md)).
- `users`, `sessions`, `accounts`, and `verification` are Better Auth's tables (epoch
  millisecond timestamps; sign-in codes stored hashed). `users.role` is `user` or `admin`.
  These, `auth_rate_limit_hits`, and `email_deliveries` hold runtime data, so bootstrap
  parity (`db:verify:local`, `verify-import`) skips their rows (`runtimeTableNames`), and
  `verify-import` requires them to be empty.
- `admin_allowlist` lists admin emails (lowercase); `auth_rate_limit_hits` is the sliding
  window behind the sign-in code limits. Its rows are pseudonymous: HMAC-SHA256 digests under
  a key derived from `BETTER_AUTH_SECRET`, never an email or IP address. `sessions` stores
  the client's raw `ip_address` and `user_agent` (Better Auth's default)
  ([Accounts](./ACCOUNTS.md)).

## Listings: source, link, and unpublishing

- `source` is `admin` (the 3,422 imported listings, publication manifests, admin-added) or
  `submission` (promoted from `listing_submissions`). The migration backfilled `admin`, and
  `submission` for any listing an approval created (`source_kind = 'verified-submission'`).
- `link_rel` is the admin setting for our outbound "Visit Site" link: `follow`, `nofollow`,
  or `sponsored`. It defaults to `follow`, which renders `rel="noopener noreferrer"` exactly as
  before; submission approvals write `nofollow`. Detail DTOs carry it as `linkRel`.
- **Unpublished** is `status = 'approved'` with `is_active = 0`: the row, slug, and
  memberships stay, every public query (pages, sitemap, search, RSS, category pages, counts)
  drops it, and `getUnpublishedListing(slug)` finds it so the route can answer 410 Gone
  instead of 404 (#64). Republishing sets `is_active = 1` and the URL works again. The
  publisher's `listing-unpublish` reaches the same state, with the same activity records
  ([Catalog hygiene](./CATALOG_HYGIENE.md)).
- A listing has a **verified owner** when `listing_owners` has a current `owner` row; detail
  DTOs carry `verifiedOwner: true` (one probe of `listing_owners_current_owner_idx`).

## Ownership, plans, revisions, and badge checks (#62)

- `listing_owners`: listing, user, `role` (`owner`; more roles can be added for teams),
  `verified_via` (`submission` | `badge_claim` | `paid_claim` | `admin`, a transfer in the
  admin panel; added by `0005_admin_panel`, which rebuilds the table), `verified_at`, and
  `revoked_at`/`revoked_reason`. A partial unique index allows one current owner per listing;
  revoking keeps the row, so the table is the ownership history. User references are
  `ON DELETE RESTRICT`: account deletion must resolve ownership first.
- `listing_submissions.plan` is the plan the submitter chose (`free` | `paid`, null while a
  draft has not chosen); `paid_at` and `refunded_at` record payment. A refund that keeps a
  listing live because its refund badge check passed (`badge_checks.kind = 'refund'`, the check
  the refund names) sets the plan to `free` (paid → free). Owners
  (`owner_user_id`), `reviewer_note`, and `rejection_reason` with `rejection_category`
  (`prohibited` | `other`) complete the review record. CHECK constraints tie these together:
  a refund never coexists with a `prohibited` rejection, a withdrawn row never holds an
  unrefunded payment (the owner cannot withdraw once paid), and a draft is native (owner and
  block key, no plan or `paid`). The statuses and transitions are in
  [Submission flow](./SUBMISSION_FLOW.md).
- `content_version` (submissions and revisions) increments on every content edit; approvals
  compare and swap on the version the reviewer saw. `published_checksum` is the listing
  checksum written when a paid submission went live before review; the live approval requires
  the listing to still have it, so an admin edit made meanwhile is never overwritten.
- **Deploy window.** The column defaults stay `status = 'pending_badge'` and `plan = 'free'`,
  as before #62, so a Worker deployed before this migration keeps writing valid legacy rows
  between migrate and deploy. **Contract for #63:** native intake writes a draft explicitly:
  `status = 'draft'`, `plan = NULL` (the column default `free` is refused for a draft),
  `owner_user_id`, `draft_saved_at` (`Date#toISOString()`), and `block_key` with
  `block_covers_subdomains` from `urlKey()`.
- **Draft clock** (#59 amendment): `draft_saved_at` (an ISO instant, required for a draft)
  starts when the draft is first saved. Edits never reset it or the reminders (the owner
  confirmed on 2026-10-06: the 30 days run from the first save), so editing cannot extend a
  hold on a URL. `draft_reminders_sent` (0 to 5) and `draft_last_reminder_at` record the claimed
  reminders; `withdrawal_reason` (`owner` | `expired` | `admin`) is set exactly when the status
  is `withdrawn`. `listing_submissions_draft_clock_idx` (drafts only) serves the reminder and
  expiry queries in `draft-plans.ts`; the schedule and the two reminder variants are in
  [Submission flow](./SUBMISSION_FLOW.md).
- **URL keys and prohibited URLs** (#59 amendments). `urlKey()`
  (`packages/utils/url-key.ts`) normalizes every website once: the WHATWG URL parser (as in
  workerd) percent-decodes, punycodes, and lowercases the host; trailing dots and a leading
  `www.` are removed. The host is the slug and the duplicate key: a website is already listed
  when a listing's slug is its host, or a listing's stored website is one of its spellings
  (`websiteSpellings()`: http or https, with or without `www.`, with or without a trailing
  slash, any query or fragment ignored on either side). Intake and the admin website edit share
  that rule (`listingWebsiteMatch`), and the stored website stays as entered. Comparing stored
  websites by host needs a stored key (#94), because most imported slugs aren't hosts.
  `block_key` is the host's
  registrable domain per the Public Suffix List, private section included (`tldts` 7.4.16,
  128 KB minified, 46 KB gzipped, no Node APIs), so `user.github.io` is its own site. The app
  computes it at intake and stores it with its scope (`block_covers_subdomains`), because SQLite
  cannot evaluate the PSL; CHECKs keep it equal to the slug or a parent domain of it. A host with
  no registrable domain (a public suffix such as `github.io`, or an IP address) is its own block
  key with an exact-host scope, so a block on it never covers the separate sites under it.
  A `prohibited` rejection inserts an active block for the block key with that scope; the trigger
  `listing_submissions_refuse_blocked_url` then refuses any new submission, free or paid, whose
  slug is the blocked key, or a subdomain of it when the block covers subdomains, until an admin
  lifts the block (`lifted_at`). `other` rejections block nothing. **Limitation:** a row written
  before #62 has no block key, so a prohibited rejection of it blocks its exact host only. Such
  rows exist only on staging (production had no submissions before #62), so there is no backfill.
- **Charges are recorded in #68's `orders`.** `paid_at` and `refunded_at` describe a payment
  applied to this submission, nothing more. **Contract for #68:** `orders` is the ledger of record
  for every charge and refund, including the ones a submission row cannot represent: a checkout
  that completes after a reviewer requested changes or rejected the submission, a duplicate
  checkout session, an upgrade of a listing unpublished during checkout, or a charge after a
  `prohibited` rejection (the row refuses `refunded_at` there). The webhook records the charge in
  `orders` first, applies it with `buildRecordSubmissionPaymentPlans` (or
  `buildRecordUnappliedPaymentPlans` for a withdrawn row) when the submission accepts it, and
  otherwise refunds it from `orders` alone.
- **Refund pending.** A paid submission rejected as `other` owes its refund from the rejection
  batch on: `status = 'rejected'`, `rejection_category = 'other'`, `paid_at` set, `refunded_at`
  null (`selectRefundPendingSubmissionsPlan`). The batch writes that marker atomically, so no
  extra column is needed; `buildRefundSubmissionPlans` (`after_rejection`) clears it. #68's
  refund hook is idempotent and is retried by a replayed rejection and by its sweep
  ([Admin panel](./ADMIN_PANEL.md#refunds)).
- `listing_revisions` stage an owner's edit of a live listing (name, description, content,
  primary category, logo, video, resource links, FAQs; never website or slug) against the
  listing's `checksum` at the time (`base_checksum`). A listing has at most one open revision,
  and none while its own submission is still in review; the logo is required, like a
  submission's.
- `badge_checks` (listing, `checked_at`, `outcome`, `reason`, `conclusive`, `kind` `weekly` |
  `confirmation` | `refund`) is the badge program history, written only by
  `packages/data-ops/src/badge-program.ts` ([Badge program](./BADGE_PROGRAM.md)); an owner's own
  checks are recorded on the submission ([Submitter dashboard](./ACCOUNT_DASHBOARD.md#badge-panel)).
  Writing it never changes the catalog epoch.
- `listing_claims` (`0008_listing_claims`) holds claims of existing listings ([Claims](./CLAIMS.md)).

These tables are empty in the initial import, so bootstrap parity compares them like the
submission tables (`scripts/d1-table-inventory.ts`).

## Hosted listing media

Listing logos and images are hosted in R2 under content-addressed keys, never hotlinked (#95).
`listing_media` stores the key with `sha256`, `content_type`, `bytes`, `width`, and `height`
(all or none, and only a `best.serp.co/listings/` key) and keeps the source in `url`;
`media_ingestions` (a runtime table) queues slots that are not hosted yet and holds a
submission's or a revision's hosted images (`best.serp.co/submissions/<id>/`,
`best.serp.co/revisions/<id>/` keys) until approval copies them (`copy_from_key`). Approvals and admin edits host a logo or queue it, never store its URL.
Details: [Listing media](./MEDIA.md).

## Statement plans

Every transition is a credential-free statement plan in `packages/data-ops`
(`submission-plans.ts`, `draft-plans.ts`, `listing-plans.ts`, `revision-plans.ts`,
`admin-plans.ts`, `plan-support.ts`; the admin panel's reads are `admin-queries.ts`) sent as
one D1 batch. Each mutation repeats its expected state in the `WHERE` and is followed by a
`changes() = 1` assertion, so a stale or concurrent decision fails the whole batch. A plan that
changes public output (publishing, unpublishing, content, `link_rel`, ownership) also records
a `publication_runs` row and advances `publication_state.version` with a compare-and-swap
(`prepareCatalogPublication` derives the ids and checksum), so cached pages turn over.
Revision and live-submission approvals move the listing to `draft` inside the batch, replace
its content, and publish it again, so the primary-category triggers stay in force.

## Public eligibility

Public queries require `status = 'approved'`, `is_active = 1`, and a `published_at`
that is not in the future. Creating or badge-verifying a submission never satisfies
those predicates; only the protected approval workflow promotes a verified row, and it
records publication provenance.

List and card operations return summary projections; only detail operations hydrate
content, media, and resource links. List pages read one page at a time
(`getListingNamePage`): the public ids of the directory or of one category in name order
are cached per epoch, and only the requested page's summaries are then read by id.

The **catalog epoch** is `publication_state.version` plus the newest public
`published_at` (`packages/data-ops/src/catalog-epoch.ts`), so it also changes when a
listing scheduled for the future becomes due. Shell counts, name order and pages,
featured and latest heads, details, and the full summary list are cached in the Workers
Cache API under epoch-scoped keys (24-hour retention, live D1 fallback on cache failure),
and the edge HTML cache uses the same epoch (see [Architecture](./ARCHITECTURE.md#caching)).

Shell statistics (category counts, listing and featured totals) come from one `GROUP BY`
pass over public memberships: ~15k rows read for the imported catalog instead of ~487k
for the previous correlated count per category. The totals sum primary memberships, which
the baseline triggers keep at exactly one per published listing.

Related listings rank by shared categories, then `name, slug`, in one statement:

- several categories: count shared memberships starting from the listing's own
  categories through `listing_categories_category_idx` (bounded by those categories'
  sizes; ~1.2k rows read at most on the live catalog, previously up to ~42k);
- one category of at most 128 listings: read that category's members;
- one larger category: walk `listings_related_name_idx`, a partial index over public
  listings, which finds four members of a dense category within a few rows.

Previous/next navigation evaluates its three keyset branches inside one `COALESCE`, which
stops at the first branch that finds a row.

## Changing data

Ongoing changes use reviewed YAML manifests under `d1/publications/`. The publisher
validates the base version, prior checksum, IDs, slugs, URLs, and categories before
sending one batch. `publish-d1-staging.yml` applies a manifest to staging first, then
`publish-d1.yml` to production ([Release guards](./RELEASE_GUARDS.md#catalog-data-staging-first)),
each after recording a D1 Time Travel bookmark (no export). A row-level manifest
(`concurrency: rows`: `listing-media-update` repoints hosted media, `listing-categories-add`
adds a secondary category, `listing-content-remove-suffix` trims a description,
`listing-claim-hold-add`/`-clear` place or clear a [claim](./CLAIMS.md) hold) checks each
listing's rows, not a base version ([media](./MEDIA.md)). Verification, rejection, and approval
batches assert `changes() = 1` after every compare-and-swap step, so stale decisions roll back.

## Initial import

The catalog was bootstrapped once from `serpcompany/json-directory-template@25e2a8d`
(`sites/serp.co/products.json`, 3,422 listings, 141 categories) with
`pnpm migration:generate`. Listing IDs are
`lst_` + `sha256("legacy-product-map" NUL <slug>)[0:24]`, so re-running the generator
produces identical rows. `best-serp-co-v1-parity.yaml` records source checksums,
counts, the SQL checksum, and the target checksum written to `publication_state`;
`best-serp-co-v1.sql.br` is the committed brotli copy of the SQL that seeds local D1 and
CI. The uncompressed SQL and per-batch files are git-ignored. Remote environments are
bootstrapped from the same checksum-verified SQL by `bootstrap-production-d1.yml`, which
imports only into an empty database and then verifies exact parity with the report.

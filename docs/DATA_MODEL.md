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
adding migrations; Drizzle cannot express them.

- `categories` stores taxonomy rows and display order (unique `slug`).
- `listings` stores public product fields, status, publication time, and stable IDs
  (unique `slug`).
- `listing_categories` stores ordered category membership with one primary category.
- `listing_media`, `listing_resource_links`, and `listing_faqs` store detail content.
- `publication_state` is a single row (`id = 1`) with the current version and checksum.
- `migration_runs` and `publication_runs` record imports and applied manifests.
- `listing_slug_redirects` maps retired slugs to their listing.
- `listing_submissions` and its resource, FAQ, event, rate-limit, and notification
  tables hold private intake. Only a digest of each access capability is stored.

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
sending one batch; `publish-d1.yml` applies a manifest to production after a D1 backup. Verification, rejection, and approval batches assert
`changes() = 1` after every compare-and-swap step, so stale decisions roll back.

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

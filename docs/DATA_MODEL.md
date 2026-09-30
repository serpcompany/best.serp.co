# D1 data model

The schema is modeled once in `packages/data-ops/src/schema.ts`. `pnpm d1:generate`
(`drizzle-kit generate`) writes reviewable SQL into `d1/drizzle/`, and Wrangler applies
it while recording the `d1_migrations` ledger. `drizzle-kit push` is not an approved
migration path.

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
content, media, and resource links. Summaries, details, category counts, and featured
counts are cached in the Workers Cache API under keys that include the publication
version, with one-hour retention and live D1 fallback on cache failure.

`listings_related_name_idx` is a partial index over public listings that keeps the
related-listings ranking (`name, slug`) a bounded seek.

## Changing data

Ongoing changes use reviewed YAML manifests under `d1/publications/`. The publisher
validates the base version, prior checksum, IDs, slugs, URLs, and categories before
sending one batch. Verification, rejection, and approval batches assert
`changes() = 1` after every compare-and-swap step, so stale decisions roll back.

## Initial import

The catalog was bootstrapped once from `serpcompany/json-directory-template@25e2a8d`
(`sites/serp.co/products.json`, 3,422 listings, 141 categories) with
`pnpm migration:generate`. Listing IDs are
`lst_` + `sha256("legacy-product-map" NUL <slug>)[0:24]`, so re-running the generator
produces identical rows. The generated SQL under `d1/artifacts/` is git-ignored; the
committed `best-serp-co-v1-parity.yaml` records source checksums, counts, and the
target checksum written to `publication_state`.

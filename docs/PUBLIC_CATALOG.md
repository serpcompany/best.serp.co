# Public catalog

What makes a listing public, the states a listing can be in, and how the public reads are
shaped. The tables, migrations, and write plans are in [Data model](./DATA_MODEL.md); the cache
layers are in [Architecture](./ARCHITECTURE.md#caching).

## Public eligibility

Public queries require `status = 'approved'`, `is_active = 1`, and a `published_at` that is not
in the future. Pages, the sitemap, search, RSS, category pages, and counts all apply them.
Creating or badge-verifying a submission never satisfies those predicates; only a plan that
records a catalog publication promotes a row ([Statement plans](./DATA_MODEL.md#statement-plans)),
so every change to public output has publication provenance.

## Listing states

- **Unpublished** is `status = 'approved'` with `is_active = 0`: the row, slug, and memberships
  stay, every public query drops it, and its URL answers 410 Gone instead of 404
  ([Admin panel](./ADMIN_PANEL.md#unpublished-listings-answer-410)). Republishing sets
  `is_active = 1` and the URL works again. The publisher's `listing-unpublish` reaches the same
  state, with the same activity records ([Catalog hygiene](./CATALOG_HYGIENE.md)).
- A **retired** category (`is_active = 0`) leaves public queries and forms; it and its listings
  answer 404, and `0011_retired_categories` keeps any published listing off it.
- `source` is who added the listing: `admin` (the import, publication manifests, admin-added) or
  `submission` (promoted from `listing_submissions`).
- `link_rel` is the admin setting for our outbound "Visit Site" link: `follow`, `nofollow`, or
  `sponsored`. It defaults to `follow`, which renders `rel="noopener noreferrer"` as the link did
  before the setting existed; submission approvals write `nofollow` unless the reviewer picks
  another.
- A listing has a **verified owner** while `listing_owners` has a current `owner` row. The badge
  is public output, so an ownership change advances the catalog epoch in the same batch.
- Listing IDs are stable across slug changes; `listing_slug_redirects` maps a retired slug to its
  listing.

## Catalog epoch

The catalog epoch is `publication_state.version` plus the newest public `published_at`
(`apps/web/src/db/catalog-epoch.ts`), so it also changes when a listing scheduled for the future
becomes due. The data cache and the edge HTML cache are both keyed by it, so a write that changes
public output advances the version in the same batch, and a write outside the catalog (a badge
check, for example) never touches it.

## Reads

List and card operations return summary projections; only detail operations hydrate content,
media, and resource links. List pages read one page at a time (`getListingNamePage`): the public
ids of the directory or of one category in name order are cached per epoch, and only the
requested page's summaries are then read by id.

Each read keeps a reviewed SQL shape, explained where it is built in
`apps/web/src/db/catalog.ts`: the shell counts come from one pass over public memberships (the
totals sum primary memberships, which the baseline triggers keep at exactly one per published
listing), related listings from one statement whose plan depends on the listing's categories,
and previous/next from one `COALESCE` over three keyset branches. Every shape has a rows-read
budget on the full import (`ROWS_READ_BUDGET` in `scripts/d1-workerd-queries.test.ts`), so a lost
index or a full scan fails a test instead of showing up on the bill.

## Search

Search matches a listing's name, short description, slug (the product's domain), and the slugs
and names of its active categories, never its long content or website URL: nearly all websites
are `serp.ly` affiliate links, so their host would match almost every short term. Input past the
length and term limits is truncated, never rejected, and ASCII letters fold like SQLite's
`lower()` while other characters match as typed. The terms are one JSON binding matched with
`instr()`, which keeps search within D1's binding and pattern limits. `searchListings` and
`normalizeSearchQuery` in `catalog.ts` hold the rules and limits; results are cached per epoch.

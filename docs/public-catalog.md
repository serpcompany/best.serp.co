# Public catalog

What makes a listing public, the states a listing can be in, and how the public reads are
shaped. The tables, migrations, and write plans are in [Data model](./data-model.md); the cache
layers are in [Caching](./caching.md).

## Public eligibility

Public queries require `status = 'approved'`, `is_active = 1`, and a `published_at` that is not
in the future. Pages, the sitemap, search, RSS, category pages, and counts all apply them.
Creating or badge-verifying a submission never satisfies those predicates; only a plan that
records a catalog publication promotes a row ([Statement plans](./data-model.md#statement-plans)),
so every change to public output has publication provenance.

## Listing states

- **Unpublished** is `status = 'approved'` with `is_active = 0`: the row, slug, and memberships
  stay, every public query drops it, and its URL answers 410 Gone instead of 404
  ([Admin panel](./admin-panel.md#unpublished-listings-answer-410)). Republishing sets
  `is_active = 1` and the URL works again. The publisher's `listing-unpublish` reaches the same
  state, with the same activity records ([Catalog hygiene](./catalog-hygiene.md)).
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
- Listing IDs are stable across slug changes; `listing_slug_redirects` maps a retired slug to the
  listing it answers 308 to: its own after a rename, or another live listing for an unpublished
  duplicate (`listing-slug-redirect`, #338). The product page looks a slug up there before it
  renders the 410 page, and so does the Worker's old root-level `/<slug>` lookup (#356); both
  follow the listing's id to its current slug, so a later rename still lands in one hop. A redirect never makes its unpublished listing public: it stays out of the
  sitemap, search, RSS, and category pages.

## Catalog epoch

The catalog epoch is `publication_state.version` plus the newest public `published_at`
(`apps/web/src/db/catalog-epoch.ts`), so it also changes when a listing scheduled for the future
becomes due. The data cache and the edge HTML cache are both keyed by it, so a write that changes
public output advances the version in the same batch, and a write outside the catalog (a badge
check, for example) never touches it.

## Reads

List and card operations return summary projections; only detail operations hydrate content,
media, resource links, and tags. List pages read one page at a time (`getListingNamePage`): the
public ids of the directory, of one category, or of one tag in name order are cached per epoch,
and only the requested page's summaries are then read by id.

Each read keeps a reviewed SQL shape, explained where it is built in
`apps/web/src/db/catalog.ts`: the shell counts come from one pass over public memberships (the
totals sum primary memberships, which the baseline triggers keep at exactly one per published
listing), related listings from one statement whose plan depends on the listing's tags or
categories, and previous/next from one `COALESCE` over three keyset branches.

The taxonomy (#341) reads only active tags, active best pages whose tag and category are active,
and public listings:

- **Tag counts** come from one pass over tag memberships, each with its hub, public count, and
  newest change.
- **The best index** lists every best page with its pool size: the public listings with its tag,
  in its category, or both, less its exclusions, plus its public pins. A tag-only page's pool is
  counted from the tag counts, so the index never reads the largest pools again. A page shows the
  first `min(listSize, poolSize)` entries: pins by position, then tag centrality, listings with a
  hosted logo, then name and slug. Nothing a Creator pays for ranks a listing. Each entry carries
  its three most central active tags, for its chips (#346).
- **Related listings** of a listing with tags are ranked by how many of its three most central
  tags they share, with ties broken from the listing's own name onward, so listings that share
  tags link to different neighbours. When its tags give fewer than four, its hub fills the rest
  in the same name order, in the same statement. A listing without tags is ranked by shared
  categories, as before.
- **Moved taxonomy URLs** follow `taxonomy_redirects` to the target's current URL, when it is
  public: a best page whose tag or category is retired is not followed.

Every shape has a rows-read budget on a generated catalog of production's size
(`ROWS_READ_BUDGET` in `scripts/d1-workerd-queries.test.ts`, #314), so a lost index or a full
scan fails a test instead of showing up on the bill.

## Search

Search matches a listing's name, short description, slug (the product's domain), and the slugs
and names of its active categories and tags, never its long content or website URL: nearly all
websites are `serp.ly` affiliate links, so their host would match almost every short term. Input
past the length and term limits is truncated, never rejected, and ASCII letters fold like
SQLite's `lower()` while other characters match as typed. The terms are one JSON binding matched
with `instr()`, which keeps search within D1's binding and pattern limits. `searchListings` and
`normalizeSearchQuery` in `catalog.ts` hold the rules and limits; results are cached per epoch.

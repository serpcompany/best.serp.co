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
check, for example) never touches it. A render of an edge cache miss reads through a D1 session at
the bookmark its epoch was read at, which a read replica may answer once replication is on
([Caching](./caching.md#read-replication), #382).

## Reads

List and card operations return summary projections; only detail operations hydrate content,
media, resource links, tags, and the active best pages that pin or exclude the listing. List
pages read one page at a time (`getListingNamePage`): the public ids of the directory, of one
category, or of one tag in name order are cached per epoch, and only the requested page's
summaries are then read by id.

Each read keeps a reviewed SQL shape, explained where it is built in
`apps/web/src/db/catalog.ts`: the shell counts come from one pass over public memberships (the
totals sum primary memberships, which the baseline triggers keep at exactly one per published
listing), and a listing's alternatives from one statement whose plan depends on its tags and its
hub's size.

A listing page's detail, its alternatives and its related listings are one D1 batch of three
statements, each finding the listing by its slug, so an uncached listing page waits on D1 once
after the catalog epoch (#378). The detail carries the listing's hand-picked alternatives; the
alternatives statement picks its plan itself, counting the hub's public members (as the shell
counts do) up to the member-scan limit, instead of reading the shell counts first; the page reads
the shell counts and the best index alongside the listing. #519 dropped the previous and next
listings (and their two statements) with the page's "Browse more"; #535 added the related
listings' statement, since the alternatives statement already has the five SELECTs a compound
SELECT may have.

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
- **Alternatives** (#519) are the listing page's Alternatives list, under Visit Site in the column
  beside its article (#535): up to six other public listings, never the listing itself, none
  twice. First its hand picks (`listing_alternatives`,
  set by [`listing-alternatives-set`](./listing-operations.md#alternatives)), the public ones in
  their order; a pick that is unpublished or not yet due is skipped while it stays so. Then
  similar listings filed under its hub (its primary category), scored 3 for each of its three most
  central tags they share and 2 for being pinned on an active best page that pins it too, with
  ties broken from the listing's own name onward, so listings that share tags link to different
  neighbours. Then its hub fills the rest in the same name order: a listing without tags or best
  pages takes the members after its own name, wrapping round to the start, so two listings of one
  large category link to different neighbours (#331, #347). Keeping the similar listings to the
  hub spreads the links: on staging's catalog the most links any one listing would receive fell
  from 47 to 25. The removed-listing page's alternatives are its category's first live listings
  ([URLs](./urls.md#the-404-page-and-the-removed-listing-page), #53); moving it to this rule is a
  follow-up.
- **Related listings** (#535) are the listing page's Related section, under its article: up to six
  more public listings in its hub, never the listing itself or one of its alternatives, none
  twice. The statement reads the hub's memberships in their index order (the listing id) onward
  from the listing's own id, wrapping round to the start, until twelve public members, so leaving
  out the at most six alternatives still leaves six; it needs no sort or hub-size probe, and reads
  at most the hub's memberships. Starting at the listing's own id spreads the links across the
  hub. A hub with nothing left to show hides the section.
- **"Featured in"** on a listing page names up to three best pages that show the listing
  (`featuredInBestPages`, #347), from the cached best index and the detail's pins and exclusions,
  so it adds no statement: a page that pins it within the entries it shows, or one whose rule
  selects it, doesn't exclude it and shows its whole pool. An unpinned listing in a larger pool
  may rank below the cut, which only the page's entries tell, so it isn't named.
- **Moved taxonomy URLs** follow `taxonomy_redirects` to the target's current URL, when it is
  public and its page renders: a best page whose tag or category is retired is not followed, and
  neither is a category or tag with no public listing or a best page with no entry (#346).

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

# Catalog publication: staging first

Every reviewed catalog change reaches staging before production (owner decision). A manifest
under `d1/publications/` and a listing media plan under `d1/media/` are applied to staging,
checked there, and applied to production only after the `staging` → `main` promotion. Code and
schema follow [Release guards](./release-guards.md); this covers data. The step-by-step media
procedure is in [Media publishing](./media-publishing.md#uploading-and-publishing).

## Order

- **Manifests.** **Publish D1 Catalog (staging)** (`publish-d1-staging.yml`) applies a manifest
  from `staging`, in the `staging` environment. After promotion, **Publish D1 Catalog**
  (`publish-d1.yml`) applies the same manifest from `main`. Each records a D1 Time Travel
  bookmark first, never a database export ([Credential guards](./credential-guards.md)).
- **Media.** **Upload Listing Media (staging)** uploads a plan to the staging bucket, and later
  **Upload Listing Media** from `main` copies staging's verified objects bucket to bucket
  through the R2 API. A plan is uploaded before the manifest that names its keys is published.
- **Who runs them.** Each dispatch needs its typed confirmation (`project.confirmation` in
  `scripts/project.ts`). Only the owner dispatches them; agents prepare and review the files
  (AGENTS.md).

No staging-verification check gates these workflows the way it gates Deploy Production: they
change data, not schema or code. For manifests, staging first is this procedure; for media, the
production upload copies the objects staging verified.

## Guards

- `d1-remote-publisher.ts` and `media-upload.ts` each refuse to run outside their own workflow,
  branch, and confirmation; the publisher also refuses a database that is not its target's.
- The uploader refuses any key outside `best.serp.co/listings/` and verifies, never
  overwrites, an object the bucket already holds.
- The publisher refuses a media manifest until the target's own bucket holds every object it
  names, byte for byte.
- The publisher refuses any statement D1's remote API would reject, even one local SQLite runs
  (`scripts/d1-compat.ts` lists them).
- **Row-level manifests** (`concurrency: rows`, holding only the operations `rowLevelActions` in
  `scripts/d1-publisher.ts` allows) check each row they change instead of a base version. Each
  fits both environments whatever else each published, and a listing that changed since
  generation refuses it with nothing written
  ([recovery](./media-publishing.md#recovering-a-refused-media-manifest)). Any other manifest names the
  base version both environments must share.

## Category operations

These operations file listings under categories and manage the categories themselves. All are
row-level, so one manifest fits staging and production. Each listing operation names the listing's
`id`, its `slug`, and `expected`: its current categories in order, primary first.

| Operation | What it does | Refused, with nothing written, when |
|---|---|---|
| `listing-categories-add` | Adds `add` as secondary categories, after the listing's last one | The slug or categories aren't exactly `expected`, or a category is missing or retired |
| `listing-categories-remove` | Removes `remove`, which must be secondary categories | The slug or categories aren't exactly `expected`, or one of them is the primary |
| `listing-categories-set` | Replaces the listing's categories with `categories`, the first as primary (#333) | As for `-add`, the listing isn't approved, or its own submission is in review (`paid_pending_review` or `changes_requested`) |
| `category-create` | Adds an active category: `slug`, `name`, `description`, `order` | The slug exists, active or retired |
| `category-unpublish` | Retires a category ([Catalog hygiene](./catalog-hygiene.md#adult-products-260)) | The slug doesn't exist, or a live listing is still filed under it |

`listing-categories-set` is the only row-level operation that changes a listing's primary category:
`-add` and `-remove` never touch it. Within the batch, it moves the listing to a draft, replaces its
memberships, and approves it again, as the admin panel's edit does, so the primary-category
triggers still hold. An unpublished listing stays unpublished. The operation also does three things:

- It sets `updated_at`, the page's sitemap `lastmod`.
- It gives the listing a new checksum. An admin edit or owner revision read before the change is
  then refused as stale, instead of putting the old primary back. A paid submission's approval
  needs the checksum the listing had at payment, which is why the operation refuses a listing
  whose own submission is in review, as `listing-unpublish` and `listing-content-remove-suffix` do.
- It logs an `edited` event, which `/admin` shows as "Details edited: categories".

Publish a manifest's `category-create` before the operations that file listings under the new
category, earlier in the same manifest or in an earlier one. A category with no live listing
answers 404. As with every publication, the catalog epoch advances, so cached pages turn over.

## Taxonomy operations

These operations write #341's taxonomy: tags, best pages, and redirects of old taxonomy URLs
(#344). All are row-level, so one manifest fits staging and production. Each refusal names its
operation and reason, and D1 reports it as `bad JSON path: '<operation> <slug>: <reason>'`.

| Operation | What it does | Refused, with nothing written, when |
|---|---|---|
| `tag-create` | Adds an active tag under a hub: `tag: {slug, name, description, category, order}` | A tag has the slug, active or retired, or the hub is missing or retired |
| `tag-update` | Rewrites a tag's name, description, hub and order (`tag`), compared with `expected` (name, description, hub). A retired tag stays retired | The tag isn't `expected`, or the new hub is missing or retired |
| `tag-unpublish` | Retires a tag and redirects its URL to `redirect` | No active tag has the slug, an active best page uses it, or the target is missing or retired |
| `listing-tags-set` | Replaces a listing's tags with `tags`, the first the most central | The slug or tags aren't `expected`, the listing isn't approved, or a tag is missing or retired |
| `best-page-create` | Adds an active best page: `page: {slug, keyword, title, heading, intro, tag, category, listSize, keywordVolume, keywordCheckedAt, order}`, on a tag, a category, or both | A best page has the slug, active or retired, or its tag or category is missing or retired |
| `best-page-update` | Rewrites every field of a best page but its slug (`page`), compared with all of them (`expected`) | The page isn't `expected`, or its new tag or category is missing or retired |
| `best-page-listings-set` | Replaces a page's pins (`pins`, positions 1, 2, … with an optional `blurb`) and exclusions (`exclude`), each `{id, slug}` | The page is missing, its pins and exclusions aren't `expected`, or a listing isn't approved with that id and slug |
| `best-page-unpublish` | Retires a best page and redirects its URL to `redirect` | No active best page has the slug, or the target is missing or retired |
| `taxonomy-redirect-set` | Points `from` (`{kind, slug}`, kind `category`, `tag` or `best`) at `to` | Its current target isn't `expected` (`null` for none), or the target is missing or retired |

A target is `{kind, slug}`, an active category, tag, or best page, or `{kind: directory}`, which
is `/products/`. Redirects store their target's id, so a later rename keeps them current.

- **Redirects never chain.** `tag-unpublish` and `best-page-unpublish` re-point every redirect
  aimed at what they retire to their own target, in the same batch. A redirect from the target's
  own URL would then point at itself, so it is removed: the target's page renders while it's
  active, and the target's own retirement writes that URL's redirect.
- **A page wins over its redirect.** A redirect can be published while its source still renders,
  as #341's first manifest does for old category URLs. It takes effect once that page empties or
  retires.
- **The end of the batch.** Every redirect the manifest wrote must still point at an active
  target, and every best page it created or updated must still use an active tag and category.
  `category-unpublish` re-points nothing, so retiring a category that one of them uses refuses the
  batch, in either order. A category retired by a later manifest isn't checked against redirects
  or best pages: re-point those first.
- **`listing-tags-set`** sets `updated_at`, the sitemap `lastmod`, and logs an `edited` event, which
  `/admin` shows as "Details edited: tags". It keeps the listing's checksum, because tags aren't
  content that revisions and admin edits compare. So it needs no draft step and allows a listing
  whose own submission is in review, whose approval still matches its paid checksum. It takes
  approved listings, live or unpublished. `expected` lists every membership, retired tags
  included, by sort order then slug. A retired tag can't be set again, so the operation drops it.
- **Retired tags.** Retiring a tag keeps its memberships, and public reads filter on the tag's
  `is_active`. Tags and memberships are written with `UPDATE`, or `INSERT … SELECT … WHERE
  is_active = 1`, never an upsert. SQLite fires a `BEFORE INSERT` trigger on an upsert's attempted
  insert even when it becomes an update, so `0013_taxonomy_triggers.sql` would refuse one that
  touches a retired tag.
- **One change per row.** A manifest changes a tag, a best page, a page's pins, a listing's tags,
  or a redirect source once. A listing's tags may sit beside another operation on that listing,
  as #341's `listing-tags-set` and `listing-categories-set` do.
- **Order.** Publish a `tag-create` before the operations that use its tag, and a
  `best-page-create` before its `best-page-listings-set`, earlier in the same manifest or in an
  earlier one.
- **Routes.** `affected_routes` names the tag and best pages, their indexes (`/products/tags/`,
  `/best/`), the hubs and listings involved, and `sitemap-tags.xml` and `sitemap-best.xml`. A
  manifest without a taxonomy operation records the same routes as before.
- **Bindings** are numbers, strings, and nulls, never booleans. D1's REST API takes them as JSON
  (`d1-compat.test.ts` checks every committed manifest).

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

## Listing details

`listing-details-set` (#340) replaces a listing's name, short description, or website, the fields
the admin panel's edit changes, for a listing whose product was renamed or whose one-line
description describes something else. It is row-level. It names the listing's `id` and `slug`, a
`reason` for the activity log, `expected` (its current `name`, `description`, and `website`, all
three), and `details` (only the fields that change, at least one).

The batch is refused, with nothing written, when:

- the slug or any of the three fields isn't exactly `expected`, or the listing isn't approved;
- its own submission is in review (`paid_pending_review` or `changes_requested`);
- a new website is another listing's, the host of a submission in flight, or under a block
  (`listingWebsiteConflicts`, which the admin edit checks too).

The manifest itself is refused when a field in `details` equals `expected`, the name is over 80
characters or the description over 160 (the admin panel's limits), or the website isn't a public
HTTP(S) URL.

Like `listing-categories-set`, it sets `updated_at` (the sitemap `lastmod`), gives the listing a
new checksum, so an admin edit or owner revision read before it is refused as stale, and logs an
`edited` event, which `/admin` shows as "Details edited: name, description". An unpublished
listing stays unpublished, its categories stay, and the long description is left as it is.

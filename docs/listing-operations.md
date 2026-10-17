# Listing operations

The publisher's row-level operations that write one listing: its name, short description, and
website, its long description, a new listing, its resource links, its hand-picked alternatives,
and its feature flag. Like every
row-level operation, each fits staging and production; the order and the publisher's guards are in
[Catalog publication](./catalog-publication.md).

## Listing details

`listing-details-set` (#340) replaces a listing's name, short description, or website, the fields
the admin panel's edit changes, for a listing whose product was renamed or whose one-line
description describes something else. It is row-level. It names the listing's `id` and `slug`, a
`reason` for the activity log, `expected` (its current `name`, `description`, and `website`, all
three), and `details` (only the fields that change, at least one).

The batch is refused, with nothing written, when:

- the slug or any of the three fields isn't exactly `expected`, or the listing isn't approved;
- its own submission is in review (`paid_pending_review` or `changes_requested`), or stands
  rejected: the listing stays down and read-only, as in the admin panel;
- a new website is another listing's, the host of a submission in flight, or under a block
  (`listingWebsiteConflicts`, which the admin edit checks too).

Each refusal names the operation and its reason in the error D1 reports, as the slug redirect's
guards do, for example `bad JSON path: 'listing-details-set ca.la: the listing is not approved, or
its slug, name, description, or website changed since the manifest'`.

The manifest itself is refused when a field in `details` equals `expected`, the name is over 80
characters or the description over 160 (the admin panel's limits), or the website isn't a public
HTTP(S) URL. All three are trimmed first, as the admin edit stores them.

Like `listing-categories-set`, it sets `updated_at` (the sitemap `lastmod`), gives the listing a
new checksum, so an admin edit or owner revision read before it is refused as stale, and logs an
`edited` event, which `/admin` shows as "Details edited: name, description". An unpublished
listing stays unpublished, its categories stay, and the long description is left as it is.

## Long descriptions

`listing-content-set` (#523) replaces a listing's long description, the Markdown its page renders,
for a listing created without one or whose description needs rewriting. It is row-level. It names
the listing's `id` and `slug`, a `reason` for the activity log, `expected.content` (its current
description exactly as stored, or `null` for none), and `content` (the new one, never blank).
`content` is trimmed and at most 5,000 characters after trimming, the submission intake's and owner
revisions' limit (`SUBMISSION_FIELD_LIMITS.content`), so a claimed listing's owner can still save a
revision; the manifest is refused when it is longer.

The batch is refused, with nothing written, when the slug or description isn't exactly `expected`
(compared with `IS`, so `null` matches a listing with none), the listing isn't approved, or its own
submission is in review or stands rejected, as for [`listing-details-set`](#listing-details). Each
refusal names the operation and its reason, for example `bad JSON path: 'listing-content-set
games.serp.co: the listing is not approved, or its slug or description changed since the
manifest'`. The manifest itself is refused when `content` equals `expected.content`.

It sets `updated_at` (the sitemap `lastmod`), gives the listing a new checksum, so an owner revision
or admin edit read before it is refused as stale instead of putting the old description back, and
logs an `edited` event, which `/admin` shows as "Details edited: content". An unpublished listing
stays unpublished. A manifest names a listing once, so a listing whose short and long descriptions
both change needs two manifests, as #523's `2026-10-17-serp-sites-fill` and `-fill-details` are.
`scripts/catalog-media.test.ts` refuses a description that embeds an image, as for `listing-create`.

## New listings

`listing-create` adds a live listing (#506). It is row-level, so one manifest fits both
environments. It names the whole `listing`: `id`, `slug`, `name`, `description`, `website`,
`publishedAt`, `categories` (the first is primary), and optionally `content`, `media` (held to the
media rule in [Guards](./catalog-publication.md#guards)), `resources`, and `faqs`. The batch
inserts it as a draft, files it, and approves it, so the primary-category triggers hold, and links
it `follow`.

The manifest is refused when the name is over 80 characters or the description over 160 (the admin
panel's limits), or the website isn't a public HTTP(S) URL; all three are trimmed first, as the
admin edit stores them. The batch is refused when:

- a listing has the id or slug (`bad JSON path: 'listing-create tools.serp.co: a listing already has
  this id or slug'`): the same listing under another manifest id, or a slug taken elsewhere;
- the website is another listing's, a submission's in flight, or blocked (`listingWebsiteConflicts`,
  as for [`listing-details-set`](#listing-details));
- a category is missing or retired.

A refused batch leaves the catalog unchanged; the remote publisher records a `failed`
`publication_runs` row, and the manifest may run again. A rerun after a success is answered as
already done (`idempotent`) before any guard. A `publication` manifest's `listing-create` runs the
same guards, records its pages in `affected_routes`, and logs no `listing_events` row.

## Resource links

`listing-resources-set` (#376) replaces a listing's resource links, the "Links" section of its
page, for links to deleted repositories or removed store items. It is row-level. It names the
listing's `id` and `slug`, a `reason` for the activity log, `expected` (every current link, `label`
and `url`, in order), and `resources` (the whole new list, in order; it may be empty).

The batch is refused, with nothing written, when the slug or any link isn't exactly `expected`, in
the same order, or the listing isn't approved, or its own submission is in review or stands
rejected, as for [`listing-details-set`](#listing-details). Each refusal names the operation and its
reason, for example `bad JSON path: 'listing-resources-set udemy-downloader: the listing is not
approved, or its slug or links changed since the manifest'`.

The manifest itself is refused when `resources` equals `expected` or repeats a link, or when a link
not in `expected` breaks the owner edit's link rule: a trimmed label of 60 characters or fewer and a
public https URL of 2,048 characters or fewer. A link the listing keeps is compared as stored, so an
imported listing's longer list of links can still lose one.

It sets `updated_at` (the sitemap `lastmod`), gives the listing a new checksum, so an owner revision
or admin edit read before it is refused as stale instead of putting the old links back, and logs an
`edited` event, which `/admin` shows as "Details edited: links". An unpublished listing stays
unpublished. `pnpm catalog:downloader-links` writes #376's manifest from the link checks recorded in
`d1/hygiene/2026-10-11-downloader-links.yaml`.

## Alternatives

`listing-alternatives-set` (#519) replaces a listing's hand-picked alternatives, which lead its
page's Alternatives list in their order; the page tops them up to six from similar listings
([Public catalog](./public-catalog.md#reads)). It is row-level. It names the listing's `id` and
`slug`, a `reason` for the activity log, `expected` (every current pick, `{id, slug}`, in order,
unpublished ones too), and `alternatives` (the whole new list, in order, each `{id, slug}`; at most
six, the most the section shows; it may be empty).

```yaml
- action: listing-alternatives-set
  id: lst_...
  slug: cursor.com
  reason: Hand-picked alternatives (#525)
  expected: []
  alternatives:
    - { id: lst_..., slug: tabnine.com }
    - { id: lst_..., slug: codeium.com }
```

The batch is refused, with nothing written, when:

- the slug or any pick isn't exactly `expected`, in the same order, or the listing isn't approved
  (`bad JSON path: 'listing-alternatives-set cursor.com: the listing is not approved, or its slug
  or alternatives changed since the manifest'`);
- a new pick isn't a live listing (approved, active, published by now) with that id and slug
  (`… the alternative tabnine.com is not this live listing`);
- by the end of the batch a pick is no longer live, for example because a later operation in the
  same manifest unpublishes it (`… by the end of the batch, the alternative tabnine.com is no
  longer live`).

The manifest itself is refused when `alternatives` equals `expected`, names the listing itself (by
id or slug), repeats a listing, or holds more than six, or when a manifest names the listing in two
`listing-alternatives-set` operations. It may sit beside another operation on the same listing, so
a manifest can create a listing and then pick its alternatives.

Picks aren't content that owner revisions and admin edits compare, so, like `listing-tags-set`, it
keeps the listing's checksum and allows a listing whose own submission is in review; it takes
approved listings, live or unpublished. It sets `updated_at` (the sitemap `lastmod`) and logs an
`edited` event, which `/admin` shows as "Details edited: alternatives". A pick unpublished later
keeps its row and drops out of the section until it is live again: every unpublish advances the
catalog version, so the cached page turns over. It needs migration `0018_listing_alternatives`, so
it is published on each environment only after the deploy that applied it.

## Feature listings

`listing-feature-listing-set` (#409) sets or clears `listings.is_feature_listing`, which marks a
listing that names one feature, add-on, model, or sub-tool of a larger site (Einstein GPT on
salesforce.com). A best page never pins one ([Admin taxonomy](./admin-taxonomy.md#categories-tags-and-best-pages-405)).
It is row-level. It names the listing's `id` and `slug`, a `reason` for the activity log, `expected`
(the current flag), and `featureListing` (the new one). The batch is refused, with nothing written,
when the slug or flag isn't `expected` or the listing isn't approved, for example `bad JSON path:
'listing-feature-listing-set slack.com: the listing is not approved, or its slug or feature flag
changed since the manifest'`. The manifest itself is refused when the two flags are equal.

No public page changes, so, like `listing-tags-set`, it keeps the checksum and `updated_at` and
records no listing route, and it allows a listing whose own submission is in review. It logs an
`edited` event, which `/admin` shows as "Details edited: feature listing". `pnpm
catalog:feature-listings` writes `2026-10-12-feature-listings` from #349's mapping
(`featureListings` in `d1/hygiene/2026-10-10-taxonomy.yaml`). It needs migration
`0015_feature_listings`, so it is published on each environment only after the deploy that applied
it: staging after this change's staging deploy, production after Deploy Production.

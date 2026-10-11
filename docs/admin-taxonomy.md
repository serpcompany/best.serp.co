# Admin taxonomy

How `/admin` changes the taxonomy (#341): a listing's tags, the categories (hubs), tags, and best
pages themselves (#405), and the categories submitters suggest (#406). The screens, requests,
decisions, and the production-write exception they share are in [Admin panel](./admin-panel.md).

## Tags (#341)

The listing page's Tags field (stock shadcn Combobox, multiple selection, the active tags grouped
by hub with the listing's own hub first) saves on its own with "Save tags": `setListingTags`
runs `buildSetListingTagsPlans`, which opens the publication only while the listing is approved,
its submission isn't rejected, and its tags are still the `expectedTags` the page showed; then
replaces them through active tags (a plain `INSERT … SELECT … WHERE is_active = 1`, never an
upsert), sets `updated_at` (the sitemap `lastmod`), logs the event, and finishes the
publication. A retired tag the listing still carries is compared but no longer offered, so
saving leaves it off. The checksum stays, which is why the edit is allowed while the listing's
own submission is in review, and that submission's approval leaves the tags as the admin set
them (payment already wrote its suggested tags). The field takes at most `MAX_LISTING_TAGS` (20).

The review screens show the Creator's suggested tags (`tag_slugs`), and "Edit, then approve"
on a submission not yet live edits them as `edits.tagSlugs` (up to three active tags), logged as
`tags` among the edited fields. A paid submission already live, or a revision, has no tag edit
at review: set the listing's tags here. Hubs, tags, and best pages themselves change through
manifests ([Catalog publication](./catalog-publication.md#taxonomy-operations)) and the screens
below.

## Categories, tags, and best pages (#405)

Don't rename or retire a post-deploy gate sample (`video-downloaders`, `ai-chatbots`,
`ai-chatbot`, `ai-copywriting`) before a merged PR moves the samples
([URLs](./urls.md#taxonomy-pages)).

The owner's decision on #405 replaced #341's design default 12 (hubs, tags, and best pages through
manifests only): admins create, edit, rename, and retire them here. `lib/admin/taxonomy-decisions.ts`
sends each as `buildTaxonomyPlans` (`src/db/taxonomy-plans.ts`): the publisher's own operations and
guards ([Taxonomy operations](./catalog-publication.md#taxonomy-operations)) with their `expected`
checks, between a publication that advances the catalog version and records the run, plus four
it lacks: `category-edit` (compared and swapped), `category-retire`, `taxonomy-rename`, and
`best-page-pins-check`.

- **Forms** (`components/admin/taxonomy-forms.tsx`, stock `Card` and `Field`s). A category has a
  name, slug, description, and order; a tag a name, slug, category, and description (its order
  stays); a best page a keyword, slug, title (its H1 too, unless a manifest set them apart), intro,
  and the tag it ranks, with a manifest's defaults for the rest (list size 10). A page a manifest
  set on a category alone (`video-downloader`) keeps it and may stay without a tag. A new or changed
  slug is lowercase words joined by hyphens (`lib/admin/taxonomy-fields.ts`), not taken by any row
  of its kind, active or retired, and not a URL that already redirects. A create form takes initial
  values, as props or from its list page's query (`?name=`), so another screen can open it filled
  in (#406).
- **Pages show as before.** A new category's page shows once a live listing is filed under it, a
  tag's once a live listing carries it, and a best page follows #346's rules: it renders with an
  entry, and is indexed and in `sitemap-best.xml` from five ([URLs](./urls.md#taxonomy-pages)).
- **Rename.** A new slug keeps the row, so its listings, pins, and the redirects aimed at it follow
  its id, and its old URL answers one 308 to the new one (`taxonomy_redirects`; for a category, the
  root-level `/<old>` too). An old URL that already had a redirect of its own (a tag that a tag-only
  best page took over) keeps it. Renaming back removes the redirect that would point at itself. A
  submission or revision still naming a renamed category resolves through that redirect at
  approval; a suggested tag naming a renamed tag is dropped, as a retired one is.
- **Retire.** The URL redirects to the page the admin picks: another category, tag, or best page
  whose page renders now (a redirect is followed only to one, #346), or `/products/`. Every redirect
  aimed at it is re-pointed there, and a page whose own URL redirects elsewhere can't be picked. A
  category can't retire while a live listing, an active tag, or an active best page is filed under
  it or draws on it, or a listing filed under it is a slug redirect's source (`category-unpublish`'s
  guards), or an unpublished listing is: its 410 would become a 404 that Republish can't undo
  (#260), so it is filed under another category first. A tag can't retire while a best page ranks
  it. A retired tag's listings keep it as a retired membership, as `tag-unpublish` leaves them.
- **Pins** (`components/admin/best-page-pins.tsx`). In order, at most the page's list size, each a
  live listing of its pool (its tag's listings, in its category when it names one too), never one
  it excludes or a listing that names a feature of a larger site: `listings.is_feature_listing`
  (#409), which the picker leaves out and `setBestPagePins` refuses (422 `feature_listing`). Only
  a reviewed manifest sets it ([Feature listings](./catalog-publication.md#feature-listings)); until
  an environment publishes `2026-10-12-feature-listings`, no listing there has it. A pin the page
  keeps keeps its blurb; its exclusions stay as manifests set them. Pins join a page's pool, so its tag
  changes only while every pin is in the new pool; otherwise the admin unpins those first. Both
  batches end with `best-page-pins-check`, which refuses a pin outside the pool.

## Category suggestions (#406)

A category a Creator suggests ([Submission categories](./submission-taxonomy.md#suggested-categories-406))
shows on the submission's or revision's review screen beside its category and tags, with its
note. While the review is open, "Create tag" and "Create category" open the #405 form in a
dialog (`embedded`), filled in with the suggested name (a tag also with the record's category).
Saving creates it as any create does. On a submission the reviewer can still edit before
approving, the new tag joins its tags, or the new category becomes its primary category, in
"Edit, then approve", and approving files the listing there. With three tags already, Create tag
opens the edits instead and asks the reviewer to remove one first. A paid submission
already live and a revision take no edits at review (#368): assign the new tag or category on the
listing page after approving. `/admin/suggestions/` lists the open suggestions (on a submission
from `pending_badge` until its decision, or an open revision), the first 500 by name as the review
queue caps its own (the page says when it shows only those), grouped by name regardless of case
and spacing so repeats show as one row, each linking its reviews and opening the tag or category
list page's create form with the name filled in (`?name=`).

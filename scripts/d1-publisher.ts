import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { z } from 'zod'
import {
  listingSubmissionRejected,
  listingWebsiteConflicts
} from '../apps/web/src/db/listing-plans'
import { IMAGE_CONTENT_TYPES, MAX_IMAGE_SIDE } from '../apps/web/src/db/media-format'
import {
  contentTypeForKey,
  MAX_MEDIA_BYTES,
  MEDIA_HASH_LENGTH,
  parseMediaKey
} from '../apps/web/src/db/media-keys'
import {
  listingHasQueuedSubmission,
  listingInRetiredCategory,
  type StatementPlan
} from '../apps/web/src/db/plan-support'
import { validatePublicHttpUrl } from '../apps/web/src/db/public-url'
import { BEST_PAGE_LIST_SIZE, taxonomyRedirectSourceKinds } from '../apps/web/src/db/schema'
import {
  bestPageColumns,
  categoryCreateStatement,
  categoryUnpublishStatements,
  exclusionsJson,
  pinsJson,
  REASONED_GUARD_FAILURE,
  sameTarget,
  taxonomyBatchChecks,
  taxonomyOperationStatements
} from '../apps/web/src/db/taxonomy-plans'
import { hasFileExtension } from '../apps/web/src/lib/seo/canonical-url'
import { isReservedListingSlug } from '../apps/web/src/lib/site'
import { assertD1Compatible } from './d1-compat'
import { validateCanonicalLocalConfig } from './d1-local-config'
import {
  bestIndexRoute,
  bestRoute,
  catalogSitemapRoutes,
  categoryRoute,
  listingIndexRoute,
  listingRoute,
  tagIndexRoute,
  tagRoute
} from './site-routes'

/**
 * How a publication batch refuses itself on D1 (#95 release blocker): an assertion `SELECT` whose
 * failing branch raises `malformed JSON`, which rolls the whole batch back, the mechanism the
 * Worker's own plans use (`assertGuard` in `apps/web/src/db/plan-support.ts`). D1's remote
 * API refuses a temporary table with `not authorized: SQLITE_AUTH`, so the earlier
 * `CREATE TEMP TABLE publication_guard` could never run there. `scripts/d1-compat.ts` keeps every
 * generated statement inside what D1 accepts.
 */
export const GUARD_FAILURE = "json_extract('', '$')"
/** Refuses the batch unless the statement right before it changed exactly one row. */
const CHANGED_ONE_GUARD = `SELECT CASE WHEN changes()=1 THEN 1 ELSE ${GUARD_FAILURE} END`

/**
 * A guard failure that says why (#338 review): it rolls the batch back like `GUARD_FAILURE`, and
 * D1 names the reason in its error (`bad JSON path: '<reason>'`), so the workflow's log says what
 * to fix. It lives with the taxonomy's shared statements (`apps/web/src/db/taxonomy-plans.ts`),
 * which the admin panel builds too (#405).
 */
export { REASONED_GUARD_FAILURE }

/** A slug that already exists; renaming or unpublishing it must stay possible. */
const existingSlug = z.string().regex(/^[a-z0-9.-]+$/)
// A listing page is `/products/<slug>/`; a slug ending in a file extension (`chart.js`) would
// make it a file URL without its trailing slash, so a published slug never ends in one.
// Category slugs have no dots.
const slug = existingSlug
  .refine(value => !hasFileExtension(value), {
    message: 'A listing slug cannot end in a file extension; its page would be served as a file.'
  })
  // `/products/categories/` and `/products/tags/` are the site's own pages (#341).
  .refine(value => !isReservedListingSlug(value), {
    message: 'A listing slug cannot be categories or tags; the site serves those pages itself.'
  })
const categorySlug = z.string().regex(/^[a-z0-9-]+$/)
const listingId = z.string().regex(/^lst_[a-z0-9][a-z0-9_-]{7,63}$/)
const checksum = z.string().regex(/^[a-f0-9]{64}$/)

function unique<T>(message: string, key: (value: T) => string) {
  return (values: T[], context: z.RefinementCtx): void => {
    const seen = new Set<string>()
    values.forEach((value, index) => {
      const id = key(value)
      if (seen.has(id)) context.addIssue({ code: z.ZodIssueCode.custom, message, path: [index] })
      seen.add(id)
    })
  }
}

const categories = z
  .array(categorySlug)
  .min(1)
  .superRefine(unique('Duplicate affected category.', value => value))
const category = z
  .object({
    slug: categorySlug,
    name: z.string().min(1),
    description: z.string().default(''),
    order: z.number().int().nonnegative().default(0)
  })
  .strict()
/**
 * The taxonomy (#341): tags and best pages are written by manifests (design 4.1) and, since #405
 * replaced design default 12 by the owner's decision, by the admin panel, on the same statements
 * (`apps/web/src/db/taxonomy-plans.ts`). Their slugs have a category's shape:
 * `/products/tags/<slug>/` and `/best/<slug>/`.
 */
const taxonomySlug = categorySlug
/** Text a page shows: never empty or only whitespace. */
const pageText = z.string().regex(/\S/u, 'Must not be blank.')
/** An ISO instant exactly as `Date#toISOString()` writes it, as `isoInstantCheck` requires. */
const isoInstant = z
  .string()
  .datetime({ precision: 3 })
  .refine(value => new Date(value).toISOString() === value, 'Must be a real ISO instant.')
const tagState = z
  .object({ name: z.string().min(1), description: z.string(), category: categorySlug })
  .strict()
/** Where a taxonomy redirect points: an active category, tag, or best page, or `/products/`. */
const taxonomyTarget = z.union([
  z.object({ kind: z.enum(taxonomyRedirectSourceKinds), slug: taxonomySlug }).strict(),
  z.object({ kind: z.literal('directory') }).strict()
])
export type TaxonomyTarget = z.infer<typeof taxonomyTarget>
/** A best page's fields as `best-page-update` compares and writes them, every one stated. */
const bestPageState = z
  .object({
    keyword: pageText,
    title: pageText,
    heading: pageText,
    intro: pageText,
    tag: taxonomySlug.nullable(),
    category: categorySlug.nullable(),
    listSize: z.number().int().min(BEST_PAGE_LIST_SIZE.min).max(BEST_PAGE_LIST_SIZE.max),
    keywordVolume: z.number().int().nonnegative().nullable(),
    keywordCheckedAt: isoInstant.nullable(),
    order: z.number().int().nonnegative()
  })
  .strict()
/** A listing a best page pins or excludes: its id and slug, as the row-level guards compare. */
const listingRef = z.object({ id: listingId, slug: existingSlug }).strict()
const bestPagePins = z
  .array(listingRef.extend({ blurb: pageText.optional() }).strict())
  .max(BEST_PAGE_LIST_SIZE.max)
const bestPageExclusions = z.array(listingRef)
type BestPageListings = {
  pins: z.infer<typeof bestPagePins>
  exclude: z.infer<typeof bestPageExclusions>
}
/** The ids and slugs a best page both pins and excludes, or names twice. */
function repeatedListingRefs(value: BestPageListings): string[] {
  const seen = new Set<string>()
  const repeated: string[] = []
  for (const entry of [...value.pins, ...value.exclude]) {
    for (const key of [entry.id, entry.slug]) {
      if (seen.has(key)) repeated.push(key)
      seen.add(key)
    }
  }
  return repeated
}
const bestPageListings = z
  .object({ pins: bestPagePins, exclude: bestPageExclusions })
  .strict()
  .superRefine((value, context) => {
    for (const key of repeatedListingRefs(value))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Listing ${key} is pinned or excluded twice.`
      })
  })
const resource = z.object({ label: z.string().min(1), url: z.string().url() }).strict()
/**
 * A resource link exactly as a listing stores it (`listing_resource_links`): what
 * `listing-resources-set` compares, and keeps when a link stays.
 */
const storedResource = z.object({ label: z.string().min(1), url: z.string().min(1) }).strict()
/** The owner edit's limits for a link's label and URL (`ACCOUNT_LIMITS` in `db/account.ts`). */
const LINK_LABEL_MAX = 60
const LINK_URL_MAX = 2048
const faq = z.object({ question: z.string().min(1), answer: z.string().min(1) }).strict()
/**
 * A hosted image a manifest names (#95): its key in the media bucket, the metadata D1 records,
 * and where the bytes came from. The catalog stores keys, never image URLs, so a manifest's logo
 * and images are hosted images; the key must carry the digest and the type's extension.
 */
export const hostedImage = z
  .object({
    bytes: z.number().int().min(1).max(MAX_MEDIA_BYTES),
    contentType: z.enum(Object.values(IMAGE_CONTENT_TYPES) as [string, ...string[]]),
    height: z.number().int().min(1).max(MAX_IMAGE_SIDE),
    key: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    source: z.string().min(1),
    width: z.number().int().min(1).max(MAX_IMAGE_SIDE)
  })
  .strict()
  .superRefine((value, context) => {
    const key = parseMediaKey(value.key)
    if (key?.scope !== 'listings' || key.hash !== value.sha256.slice(0, MEDIA_HASH_LENGTH)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid hosted media key.' })
    } else if (contentTypeForKey(value.key) !== value.contentType) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A media key’s extension must match its content type.'
      })
    }
  })
export type HostedImageEntry = z.infer<typeof hostedImage>
const media = z
  .object({
    logo: hostedImage.optional(),
    images: z
      .array(hostedImage)
      .superRefine(unique('Duplicate listing image.', value => value.key))
      .optional(),
    video: z.string().url().optional()
  })
  .strict()
/**
 * One logo or image row of a listing as a row-level manifest expects it: kind, source `url`, and
 * hosted `key` (null for an imported row the migration has not repointed yet).
 */
const mediaRow = z
  .object({
    kind: z.enum(['logo', 'image']),
    url: z.string().min(1),
    key: z.string().min(1).nullable().default(null)
  })
  .strict()
export type ExpectedMediaRow = z.input<typeof mediaRow>
const listing = z
  .object({
    id: listingId,
    slug,
    name: z.string().min(1),
    description: z.string().min(1),
    website: z.string().url(),
    content: z.string().optional(),
    entityType: z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .optional(),
    priority: z.enum(['high', 'medium', 'low']).optional(),
    isUnofficial: z.boolean().default(false),
    featured: z.boolean().default(false),
    // An ISO instant, or a calendar date as every imported listing stores it. Listings sort by
    // `published_at` text, so rewriting an imported `2026-05-16` as `2026-05-16T00:00:00.000Z`
    // would move that listing above every other listing published that day (#89).
    publishedAt: z.union([z.string().datetime(), z.string().date()]),
    categories: z
      .array(categorySlug)
      .min(1)
      .superRefine(unique('Duplicate listing category.', value => value)),
    media: media.optional(),
    resources: z
      .array(resource)
      .superRefine(unique('Duplicate listing resource.', value => `${value.label}\0${value.url}`))
      .optional(),
    faqs: z
      .array(faq)
      .superRefine(unique('Duplicate listing FAQ.', value => value.question))
      .optional()
  })
  .strict()
/** The admin panel's limits for a listing's name and short description (`lib/admin/decisions.ts`). */
const LISTING_NAME_MAX = 80
const LISTING_DESCRIPTION_MAX = 160
/**
 * A new listing (#506 review): its name, short description, and website are trimmed and capped
 * as `listing-details-set` takes them, the admin edit's rules, so the admin edit can save the
 * listing unchanged and the exact website match finds it. The website's public-URL rule is in
 * `manifestSchema`. `listing-update` keeps the shared `listing`, so stored rows still match it.
 */
const createdListing = listing.extend({
  name: z.string().trim().min(1).max(LISTING_NAME_MAX),
  description: z.string().trim().min(1).max(LISTING_DESCRIPTION_MAX),
  website: z.string().trim().url()
})
/** The listing fields `listing-details-set` compares and replaces, in the order it logs them. */
const listingDetailFields = ['name', 'description', 'website'] as const
const operation = z.discriminatedUnion('action', [
  z.object({ action: z.literal('listing-create'), listing: createdListing }).strict(),
  z
    .object({ action: z.literal('listing-update'), listing, previousCategories: categories })
    .strict(),
  /**
   * Live → unpublished, the admin panel's state (#64): `status` stays `approved`, `is_active`
   * becomes 0, the row is kept, and the URL answers 410 Gone. `reason` goes to the activity log.
   * `expected` is the row the manifest was generated against (#100): the batch refuses a listing
   * whose website changed since, so the operation stays correct on any environment, and a
   * row-level (`rows`) manifest requires it. `expected.unowned` (#332) also refuses a listing
   * that anyone owns, claims, or paid for (`LISTING_HAS_OWNERSHIP_RECORDS`): a retirement in
   * favour of another listing would leave those records on the unpublished row.
   */
  z
    .object({
      action: z.literal('listing-unpublish'),
      id: listingId,
      slug: existingSlug,
      categories,
      reason: z.string().trim().min(1).max(200).optional(),
      expected: z
        .object({ website: z.string().url(), unowned: z.literal(true).optional() })
        .strict()
        .optional()
    })
    .strict(),
  /**
   * Removes the end of a listing's long description, keeping every other character (#105: the
   * import's FAQ blocks, which the FAQs section now shows). Row-level guarded: the description
   * must still be `expected.contentLength` characters (SQLite characters, code points) and end
   * with exactly `suffix`, so a description edited since is refused, never cut elsewhere.
   */
  z
    .object({
      action: z.literal('listing-content-remove-suffix'),
      id: listingId,
      slug: existingSlug,
      reason: z.string().trim().min(1).max(200),
      expected: z.object({ contentLength: z.number().int().positive() }).strict(),
      suffix: z.string().min(1)
    })
    .strict(),
  z
    .object({
      action: z.literal('listing-slug-change'),
      id: listingId,
      from: existingSlug,
      to: slug,
      categories,
      reason: z.string().min(1)
    })
    .strict(),
  /**
   * Sends an unpublished listing's slug to another, live listing with a 308 (#338: #332's retired
   * duplicates go to the listing they duplicated instead of answering 410). It adds one
   * `listing_slug_redirects` row, `(to.id, from.slug, to.slug)`. The product page looks a slug up
   * there before it renders the gone page and follows `to.id` to that listing's current slug, so
   * a later rename of `to` still lands in one hop. `from` stays unpublished, so it stays out of
   * the sitemap, search, RSS and category pages, and Republish in `/admin` can still bring it
   * back (its live page then wins over the redirect).
   *
   * Row-level guarded, so a `rows` manifest may hold it. The batch refuses when:
   * - `from` isn't this id and slug, unpublished (`approved`, `is_active = 0`) as its 410 page
   *   finds it: never filed under a retired category, whose listings answer 404 (#260);
   * - `to` isn't this id and slug, live (`approved`, `is_active = 1`, published by now);
   * - a redirect already exists for `from.slug`;
   * - `to.slug` is itself a redirected slug (a chain, or a loop back to `from`);
   * - older slugs redirect to `from` (a chain: they would end at an unpublished listing);
   * - by the end of the batch, `from` is live again or filed under a retired category, or `to` is
   *   no longer live (#338 review: a later operation in the same batch, in any order).
   *
   * A later `category-unpublish` refuses while `from` is filed under that category, so a redirected
   * listing never ends up in a retired category with a 308 instead of its 404 (#260).
   */
  z
    .object({
      action: z.literal('listing-slug-redirect'),
      from: z.object({ id: listingId, slug: existingSlug }).strict(),
      to: z.object({ id: listingId, slug: existingSlug }).strict(),
      reason: z.string().trim().min(1).max(200)
    })
    .strict(),
  /**
   * Replaces a listing's logo and images with hosted copies (#95). `expected` is the listing's
   * logo and image rows (kind, source url, and hosted key, ordered by kind then sort order) when
   * the manifest was generated: the batch refuses a listing whose media changed since (a
   * row-level compare-and-swap, so the operation fits any environment whose rows match). Keys
   * belong to the slug. The listing's queued media slots are dropped: the manifest wins where it
   * writes the slot's kind and sort order with new media, neither the same source nor the same
   * bytes (the key's digest) as an `expected` row of that kind. It is refused while the listing has a pending or failed logo or image slot it would drop without
   * replacing (#336, #458), such as an approval's new logo behind a renamed listing's update,
   * empty (`expected: []`, `media: {}`), naming images, or re-hosting the old logo.
   */
  z
    .object({
      action: z.literal('listing-media-update'),
      id: listingId,
      slug: existingSlug,
      expected: z.array(mediaRow),
      media: z
        .object({
          logo: hostedImage.optional(),
          images: z
            .array(hostedImage)
            .superRefine(unique('Duplicate listing image.', value => value.key))
            .optional()
        })
        .strict()
    })
    .strict(),
  /**
   * Adds categories to a listing as secondary (never primary) memberships, compared and swapped
   * on the listing's slug and its current categories (`expected`, slugs in sort order), so it is
   * row-level like `listing-media-update` (#98: the Adult category for adult downloaders).
   */
  z
    .object({
      action: z.literal('listing-categories-add'),
      id: listingId,
      slug: existingSlug,
      expected: z.array(categorySlug).min(1),
      add: categories
    })
    .strict(),
  /**
   * Removes secondary (never primary) categories from a listing, compared and swapped on its slug
   * and current categories like `listing-categories-add` (#260: the Adult category off the
   * fan-site downloaders that stay, so Adult can retire).
   */
  z
    .object({
      action: z.literal('listing-categories-remove'),
      id: listingId,
      slug: existingSlug,
      expected: z.array(categorySlug).min(1),
      remove: categories
    })
    .strict(),
  /**
   * Replaces a listing's categories, primary first, compared and swapped on its slug and current
   * categories like `listing-categories-add` (#333: listings filed only under Other move to real
   * categories, which `-add` and `-remove` can't do, as they never touch the primary). The listing
   * is a draft inside the batch while its memberships are replaced, as the admin panel's edit does,
   * so the primary-category triggers hold; every category must be active, and the listing's own
   * submission must not be in review.
   */
  z
    .object({
      action: z.literal('listing-categories-set'),
      id: listingId,
      slug: existingSlug,
      expected: z.array(categorySlug).min(1),
      categories
    })
    .strict(),
  /**
   * Replaces a listing's name, short description, or website (#340: the product behind a listing
   * was renamed, or its copy describes something else), compared and swapped on its slug and all
   * three current values (`expected`), so it is row-level like `listing-categories-set`. `details`
   * names only what changes. As the admin panel's edit does (#64), it refuses a listing that isn't
   * approved or whose own submission is in review or was rejected, and a new website that another
   * listing, a submission in flight, or a block already covers (`listingWebsiteConflicts`).
   */
  z
    .object({
      action: z.literal('listing-details-set'),
      id: listingId,
      slug: existingSlug,
      reason: z.string().trim().min(1).max(200),
      expected: z
        .object({
          name: z.string().min(1),
          description: z.string().min(1),
          website: z.string().url()
        })
        .strict(),
      details: z
        .object({
          name: z.string().trim().min(1).max(LISTING_NAME_MAX).optional(),
          description: z.string().trim().min(1).max(LISTING_DESCRIPTION_MAX).optional(),
          // Trimmed as the admin edit stores it, so the exact website match still finds it.
          website: z.string().trim().url().optional()
        })
        .strict()
    })
    .strict(),
  /**
   * Replaces a listing's resource links, the page's "Links" section (#376: links to deleted
   * repositories and removed store items), compared and swapped on its slug and every current
   * link in order (`expected`), so it is row-level like `listing-details-set`. `resources` is the
   * whole new list, in order; a link not in `expected` follows the owner edit's link rule. As the
   * admin panel's edits do (#64), it refuses a listing that isn't approved or whose own submission
   * is in review or was rejected.
   */
  z
    .object({
      action: z.literal('listing-resources-set'),
      id: listingId,
      slug: existingSlug,
      reason: z.string().trim().min(1).max(200),
      expected: z.array(storedResource),
      resources: z
        .array(storedResource)
        .superRefine(unique('Duplicate listing resource.', value => `${value.label}\0${value.url}`))
    })
    .strict(),
  /**
   * Marks a listing as naming one feature, add-on, model, or sub-tool of a larger site, or clears
   * the mark (#409: #349's `featureListings`, which a best page never pins), compared and swapped
   * on its slug and current flag (`expected`), so it is row-level. The flag changes no public page
   * and no content that revisions and admin edits compare, so, like `listing-tags-set`, it keeps
   * the listing's checksum and `updated_at` and allows a listing whose own submission is in review.
   * Refused when the listing isn't approved.
   */
  z
    .object({
      action: z.literal('listing-feature-listing-set'),
      id: listingId,
      slug: existingSlug,
      reason: z.string().trim().min(1).max(200),
      expected: z.boolean(),
      featureListing: z.boolean()
    })
    .strict(),
  /**
   * Holds a listing's instant claim for the owner's review (#67, #108 review round 3): #100's
   * owner-review sets, or one an admin names. Row-level guarded: the listing must still have this
   * slug and, with `expected`, this website. An active hold is left as it is; a cleared one is
   * placed again.
   */
  z
    .object({
      action: z.literal('listing-claim-hold-add'),
      id: listingId,
      slug: existingSlug,
      reason: z.enum(['off_domain', 'unreachable', 'admin']),
      note: z.string().trim().min(1).max(200),
      expected: z.object({ website: z.string().url() }).strict().optional()
    })
    .strict(),
  /**
   * Clears a listing's active claim hold (#67): the owner decided it can be claimed. With
   * `expected.website` (#340), only once the listing has that website: a hold cleared because a
   * rename fixed the link waits for the manifest that sets it, and is refused before it.
   */
  z
    .object({
      action: z.literal('listing-claim-hold-clear'),
      id: listingId,
      slug: existingSlug,
      note: z.string().trim().min(1).max(200),
      expected: z.object({ website: z.string().url() }).strict().optional()
    })
    .strict(),
  z.object({ action: z.literal('category-create'), category }).strict(),
  z.object({ action: z.literal('category-update'), category }).strict(),
  /**
   * Retires a category (`is_active = 0`): it leaves the navigation, the category index, the
   * sitemaps, search, and the submit and edit forms, its page answers 404, and so do its
   * unpublished listings (#260). Refused while any live listing remains in it, primary or
   * secondary, so it follows the unpublish operations of its listings. That guard is its own
   * row-level check, so a `rows` manifest may hold it (#260: the Adult category). Also refused
   * while a listing filed under it is a slug redirect's source (#338): re-file that listing first.
   */
  z.object({ action: z.literal('category-unpublish'), slug: categorySlug }).strict(),
  /**
   * The taxonomy (#341, design 4.1). Every operation below is row-level: it checks the rows it
   * changes, refusing the whole batch with a reason when they aren't as the manifest expects.
   *
   * A new active tag under an active category (its hub). Refused when a tag has the slug,
   * active or retired, or the hub is missing or retired.
   */
  z
    .object({
      action: z.literal('tag-create'),
      tag: z
        .object({
          slug: taxonomySlug,
          name: z.string().min(1),
          description: z.string().default(''),
          category: categorySlug,
          order: z.number().int().nonnegative().default(0)
        })
        .strict()
    })
    .strict(),
  /**
   * Rewrites a tag's name, description, hub, and order, compared and swapped on `expected`. Its
   * slug and its active or retired state stay as they are. Refused when the tag isn't as
   * `expected` or the new hub is missing or retired.
   */
  z
    .object({
      action: z.literal('tag-update'),
      slug: taxonomySlug,
      expected: tagState,
      tag: tagState.extend({ order: z.number().int().nonnegative() }).strict()
    })
    .strict(),
  /**
   * Retires an active tag. Its listings keep their memberships (public reads filter on the tag's
   * `is_active`), its URL redirects to `redirect`, and every redirect aimed at it is re-pointed
   * there, so redirects never chain. Refused while an active best page uses the tag, or when the
   * target is missing or retired, or its own URL redirects elsewhere.
   */
  z
    .object({ action: z.literal('tag-unpublish'), slug: taxonomySlug, redirect: taxonomyTarget })
    .strict(),
  /**
   * Replaces a listing's tags, in order (the first is the most central), compared and swapped on
   * its slug and current tags (`expected`, ordered by sort order then slug, retired ones
   * included). It doesn't change the listing's checksum: tags aren't content that revisions and
   * the admin edit compare, so a paid submission in review can still be approved. Refused when the
   * listing isn't approved or isn't as expected, or a tag is missing or retired.
   */
  z
    .object({
      action: z.literal('listing-tags-set'),
      id: listingId,
      slug: existingSlug,
      expected: z.array(taxonomySlug).superRefine(unique('Duplicate listing tag.', value => value)),
      tags: z.array(taxonomySlug).superRefine(unique('Duplicate listing tag.', value => value))
    })
    .strict(),
  /**
   * A new active best page at `/best/<slug>/`, whose pool is its tag's listings, its category's,
   * or both together. Refused when a best page has the slug, active or retired, or a named tag or
   * category is missing or retired.
   */
  z
    .object({
      action: z.literal('best-page-create'),
      page: z
        .object({
          slug: taxonomySlug,
          keyword: pageText,
          title: pageText,
          heading: pageText,
          intro: pageText,
          tag: taxonomySlug.nullable().default(null),
          category: categorySlug.nullable().default(null),
          listSize: z
            .number()
            .int()
            .min(BEST_PAGE_LIST_SIZE.min)
            .max(BEST_PAGE_LIST_SIZE.max)
            .default(BEST_PAGE_LIST_SIZE.default),
          keywordVolume: z.number().int().nonnegative().nullable().default(null),
          keywordCheckedAt: isoInstant.nullable().default(null),
          order: z.number().int().nonnegative().default(0)
        })
        .strict()
    })
    .strict(),
  /**
   * Rewrites every field of a best page but its slug, compared and swapped on `expected`. Refused
   * when the page isn't as `expected`, or a named tag or category is missing or retired.
   */
  z
    .object({
      action: z.literal('best-page-update'),
      slug: taxonomySlug,
      expected: bestPageState,
      page: bestPageState
    })
    .strict(),
  /**
   * Replaces a best page's pins (positions 1, 2, … in order, each with an optional blurb) and
   * exclusions, compared and swapped on `expected`. Refused when the page is missing, its pins
   * and exclusions aren't `expected`, or a listing isn't approved with that id and slug.
   */
  z
    .object({
      action: z.literal('best-page-listings-set'),
      slug: taxonomySlug,
      expected: bestPageListings,
      pins: bestPagePins,
      exclude: bestPageExclusions
    })
    .strict(),
  /**
   * Retires an active best page: its URL redirects to `redirect`, and every redirect aimed at it
   * is re-pointed there, so redirects never chain. Refused when the target is missing or retired,
   * or its own URL redirects elsewhere.
   */
  z
    .object({
      action: z.literal('best-page-unpublish'),
      slug: taxonomySlug,
      redirect: taxonomyTarget
    })
    .strict(),
  /**
   * Points an old category, tag, or best page URL at an active target, or at `/products/`. The
   * page itself takes precedence while it renders, so a redirect can be published before its
   * source empties (design 2.2). Compared and swapped on `expected`, the current target or null
   * for none. Refused when the current target isn't `expected`, the target is missing or retired,
   * or it would make a chain: the target's own URL redirects, or a redirect already ends here.
   */
  z
    .object({
      action: z.literal('taxonomy-redirect-set'),
      from: z.object({ kind: z.enum(taxonomyRedirectSourceKinds), slug: taxonomySlug }).strict(),
      expected: taxonomyTarget.nullable(),
      to: taxonomyTarget
    })
    .strict()
])
/** The taxonomy's operations (#344); a manifest holding one records the taxonomy's sitemaps. */
const taxonomyActions = new Set<string>([
  'tag-create',
  'tag-update',
  'tag-unpublish',
  'listing-tags-set',
  'best-page-create',
  'best-page-update',
  'best-page-listings-set',
  'best-page-unpublish',
  'taxonomy-redirect-set'
])
type Operation = z.infer<typeof operation>
type TaxonomyOperation = Extract<
  Operation,
  {
    action:
      | 'tag-create'
      | 'tag-update'
      | 'tag-unpublish'
      | 'listing-tags-set'
      | 'best-page-create'
      | 'best-page-update'
      | 'best-page-listings-set'
      | 'best-page-unpublish'
      | 'taxonomy-redirect-set'
  }
>
const isTaxonomyOperation = (op: Operation): op is TaxonomyOperation =>
  taxonomyActions.has(op.action)

/**
 * A taxonomy operation's manifest-level checks. One manifest changes a tag, a best page, its
 * pins, a listing's tags, or a redirect source once (`claims`), so no two of its operations can
 * disagree about one row. A listing's tags are claimed apart from its other operations: the
 * migration sets a listing's tags and its categories in one manifest (design 4.2).
 */
function refineTaxonomyOperation(
  op: TaxonomyOperation,
  claims: Set<string>,
  issue: (message: string, path?: (string | number)[]) => void
): void {
  const claim = (key: string, message: string) => {
    if (claims.has(key)) issue(message)
    claims.add(key)
  }
  const redirectSource = (kind: string, slug: string) =>
    claim(`redirect\0${kind}\0${slug}`, 'Duplicate taxonomy redirect source.')
  switch (op.action) {
    case 'tag-create':
    case 'tag-update':
    case 'tag-unpublish': {
      const slug = op.action === 'tag-create' ? op.tag.slug : op.slug
      claim(`tag\0${slug}`, 'Duplicate tag operation target.')
      if (op.action === 'tag-unpublish') {
        redirectSource('tag', op.slug)
        if (sameTarget(op.redirect, { kind: 'tag', slug: op.slug }))
          issue('A tag cannot redirect to itself.', ['redirect'])
      }
      return
    }
    case 'listing-tags-set':
      claim(`listing-tags\0${op.id}`, 'Duplicate listing-tags-set listing.')
      if (op.tags.join('\0') === op.expected.join('\0'))
        issue('The listing already has exactly these tags.', ['tags'])
      return
    case 'best-page-create':
    case 'best-page-update':
    case 'best-page-unpublish': {
      const slug = op.action === 'best-page-create' ? op.page.slug : op.slug
      claim(`best\0${slug}`, 'Duplicate best page operation target.')
      if (op.action === 'best-page-unpublish') {
        redirectSource('best', op.slug)
        if (sameTarget(op.redirect, { kind: 'best', slug: op.slug }))
          issue('A best page cannot redirect to itself.', ['redirect'])
        return
      }
      if (op.page.tag === null && op.page.category === null)
        issue('A best page needs a tag, a category, or both.', ['page'])
      if (
        op.action === 'best-page-update' &&
        JSON.stringify(bestPageColumns(op.page)) === JSON.stringify(bestPageColumns(op.expected))
      )
        issue('The best page already has exactly these values.', ['page'])
      return
    }
    case 'best-page-listings-set':
      claim(`best-listings\0${op.slug}`, 'Duplicate best-page-listings-set page.')
      for (const key of repeatedListingRefs(op))
        issue(`Listing ${key} is pinned or excluded twice.`, ['pins'])
      if (
        pinsJson(op.pins) === pinsJson(op.expected.pins) &&
        exclusionsJson(op.exclude) === exclusionsJson(op.expected.exclude)
      )
        issue('The best page already has exactly these pins and exclusions.', ['pins'])
      return
    case 'taxonomy-redirect-set':
      redirectSource(op.from.kind, op.from.slug)
      if (sameTarget(op.to, op.from)) issue('A taxonomy URL cannot redirect to itself.', ['to'])
      if (sameTarget(op.to, op.expected)) issue('The redirect already points there.', ['to'])
      return
  }
}
const provenance = z
  .object({
    actor: z.string().regex(/^[a-zA-Z0-9@._-]{2,128}$/),
    workflow: z.string().regex(/^[a-z0-9][a-z0-9._/-]{1,127}$/),
    beforeChecksum: checksum.optional()
  })
  .strict()
/**
 * How a manifest guards against concurrent catalog writes (#97 review B3):
 * - `publication` (the default): it applies only at `basePublicationVersion` and
 *   `provenance.beforeChecksum`, the catalog it was written against.
 * - `rows`: every operation carries its own row-level compare-and-swap
 *   (`rowLevelActions`), so one manifest fits staging and production whatever
 *   else each environment published. It names no base; the publisher plans it against the
 *   publication state it reads at publish time and still advances the version.
 */
export const manifestConcurrency = ['publication', 'rows'] as const
/**
 * Operations that carry their own row-level compare-and-swap, so a `rows` manifest may hold them:
 * media rows (`expected`), categories (`expected`, added, removed, or replaced), a description's
 * length and ending (#105), an unpublish with its `expected.website` (#100: categories, live,
 * website, no submission in review; with `expected.unowned`, no ownership records either, #332), a
 * category retirement (#260: no live listing and no slug redirect's source left in it, #338), a new
 * category (#333: its insert refuses the batch when the slug exists, retired or not), a slug
 * redirect (#338: an unpublished source, a live target, no redirect for the slug, no chain or
 * loop, all still true at the end of the batch), a listing's name, short description, and website
 * (#340: `expected`), a listing's resource links (#376: `expected`, every link in order), its
 * feature-of-a-larger-site flag (#409: `expected`), a new listing (#506: its id and slug unused,
 * and its website no other listing's, no submission's in flight, and not blocked), and every
 * taxonomy operation (#344: each compares the tag, best page, listing, or redirect it changes).
 */
const rowLevelActions = new Set<string>([
  'listing-create',
  'listing-media-update',
  'listing-categories-add',
  'listing-categories-remove',
  'listing-categories-set',
  'listing-details-set',
  'listing-resources-set',
  'listing-feature-listing-set',
  'listing-content-remove-suffix',
  'listing-unpublish',
  'listing-claim-hold-add',
  'listing-claim-hold-clear',
  'listing-slug-redirect',
  'category-create',
  'category-unpublish',
  ...taxonomyActions
])
export const manifestSchema = z
  .object({
    version: z.literal(1),
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]+$/),
    concurrency: z.enum(manifestConcurrency).default('publication'),
    basePublicationVersion: z.number().int().nonnegative().optional(),
    provenance,
    operations: z.array(operation).min(1)
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set<string>()
    const slugs = new Set<string>()
    const categoryTargets = new Set<string>()
    if (value.concurrency === 'rows') {
      if (value.basePublicationVersion !== undefined || value.provenance.beforeChecksum) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'A row-level manifest names no base version or checksum; it is planned at publish time.',
          path: ['basePublicationVersion']
        })
      }
      value.operations.forEach((op, index) => {
        if (!rowLevelActions.has(op.action)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              'A row-level manifest holds only listing-create, listing-media-update, listing-categories-add/-remove/-set, listing-details-set, listing-resources-set, listing-feature-listing-set, listing-content-remove-suffix, listing-unpublish, listing-claim-hold-add/-clear, listing-slug-redirect, category-create/-unpublish, and taxonomy (tag-*, listing-tags-set, best-page-*, taxonomy-redirect-set) operations.',
            path: ['operations', index, 'action']
          })
        }
        // Without its website, an unpublish would guard only the categories and live state.
        if (op.action === 'listing-unpublish' && !op.expected) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'A row-level listing-unpublish needs expected.website.',
            path: ['operations', index, 'expected']
          })
        }
      })
    } else if (
      value.basePublicationVersion === undefined ||
      value.provenance.beforeChecksum === undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A manifest needs basePublicationVersion and provenance.beforeChecksum.',
        path: ['basePublicationVersion']
      })
    }
    const taxonomyClaims = new Set<string>()
    value.operations.forEach((op, index) => {
      if (isTaxonomyOperation(op)) {
        refineTaxonomyOperation(op, taxonomyClaims, (message, path = []) =>
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message,
            path: ['operations', index, ...path]
          })
        )
        return
      }
      if (
        op.action === 'listing-content-remove-suffix' &&
        [...op.suffix].length >= op.expected.contentLength
      )
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'The suffix must be shorter than the description.',
          path: ['operations', index, 'suffix']
        })
      if (op.action === 'listing-categories-add') {
        for (const slug of op.add) {
          if (op.expected.includes(slug)) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              message: `The listing already has category ${slug}.`,
              path: ['operations', index, 'add']
            })
          }
        }
      }
      if (op.action === 'listing-categories-remove') {
        for (const slug of op.remove) {
          if (!op.expected.includes(slug)) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              message: `The listing does not have category ${slug}.`,
              path: ['operations', index, 'remove']
            })
          }
        }
        if (op.remove.length >= op.expected.length) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'A listing keeps at least one category.',
            path: ['operations', index, 'remove']
          })
        }
      }
      if (
        op.action === 'listing-categories-set' &&
        op.categories.join('\0') === op.expected.join('\0')
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'The listing already has exactly these categories.',
          path: ['operations', index, 'categories']
        })
      }
      // The submission intake's and the admin edit's URL rule, as for `listing-details-set`.
      if (op.action === 'listing-create' && !validatePublicHttpUrl(op.listing.website).ok)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'A listing website must be a public HTTP(S) URL.',
          path: ['operations', index, 'listing', 'website']
        })
      if (op.action === 'listing-details-set') {
        const changed = listingDetailFields.filter(
          field => op.details[field] !== undefined && op.details[field] !== op.expected[field]
        )
        if (changed.length === 0 || changed.length !== Object.keys(op.details).length)
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Name in details only the fields that change, and at least one.',
            path: ['operations', index, 'details']
          })
        // The submission intake's and the admin edit's URL rule (#64 review).
        if (op.details.website !== undefined && !validatePublicHttpUrl(op.details.website).ok)
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'A listing website must be a public HTTP(S) URL.',
            path: ['operations', index, 'details', 'website']
          })
      }
      if (op.action === 'listing-resources-set') {
        const key = (link: { label: string; url: string }) => `${link.label}\0${link.url}`
        if (JSON.stringify(op.resources) === JSON.stringify(op.expected))
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'The listing already has exactly these links.',
            path: ['operations', index, 'resources']
          })
        // A link the listing keeps is compared as it is stored; a new one follows the owner
        // edit's rule (`validateExtras` in `db/account.ts`), whatever count the listing carries.
        const kept = new Set(op.expected.map(key))
        op.resources.forEach((link, order) => {
          if (kept.has(key(link))) return
          const checked = link.url.length <= LINK_URL_MAX ? validatePublicHttpUrl(link.url) : null
          if (
            link.label !== link.label.trim() ||
            link.label.length > LINK_LABEL_MAX ||
            link.url !== link.url.trim() ||
            !checked?.ok ||
            checked.url.protocol !== 'https:'
          )
            context.addIssue({
              code: z.ZodIssueCode.custom,
              message: `A new link needs a trimmed label of ${LINK_LABEL_MAX} characters or fewer and a public https URL.`,
              path: ['operations', index, 'resources', order]
            })
        })
      }
      if (op.action === 'listing-feature-listing-set' && op.featureListing === op.expected)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'The listing already has this flag.',
          path: ['operations', index, 'featureListing']
        })
      if (op.action === 'listing-media-update') {
        const keyed = [
          ...(op.media.logo ? [['logo', op.media.logo.key] as const] : []),
          ...(op.media.images ?? []).map(image => ['image', image.key] as const)
        ]
        for (const [kind, key] of keyed) {
          const parsed = parseMediaKey(key)
          if (parsed && (parsed.slug !== op.slug || parsed.kind !== kind)) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Media key ${key} is not this listing's ${kind}.`,
              path: ['operations', index, 'media']
            })
          }
        }
      }
      if (op.action === 'listing-slug-change' && op.from === op.to)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Old and new slugs must differ.',
          path: ['operations', index, 'to']
        })
      if (
        op.action === 'listing-slug-redirect' &&
        (op.from.id === op.to.id || op.from.slug === op.to.slug)
      )
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'A listing slug cannot redirect to its own listing.',
          path: ['operations', index, 'to']
        })
      if (
        op.action === 'category-create' ||
        op.action === 'category-update' ||
        op.action === 'category-unpublish'
      ) {
        const target = op.action === 'category-unpublish' ? op.slug : op.category.slug
        if (categoryTargets.has(target))
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Duplicate category operation target.',
            path: ['operations', index]
          })
        categoryTargets.add(target)
        return
      }
      // A redirect changes nothing of its target's row, so only its source counts here.
      const id =
        op.action === 'listing-create' || op.action === 'listing-update'
          ? op.listing.id
          : op.action === 'listing-slug-redirect'
            ? op.from.id
            : op.id
      const target =
        op.action === 'listing-create' || op.action === 'listing-update'
          ? op.listing.slug
          : op.action === 'listing-slug-change'
            ? op.to
            : op.action === 'listing-slug-redirect'
              ? op.from.slug
              : op.slug
      if (ids.has(id))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Duplicate listing operation ID.',
          path: ['operations', index]
        })
      if (slugs.has(target))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Duplicate listing operation slug.',
          path: ['operations', index]
        })
      ids.add(id)
      slugs.add(target)
    })
    // A redirect to a listing this manifest unpublishes would end at a gone page. Its own guard
    // catches an unpublish that comes first; this catches one that comes after it.
    const unpublished = new Set(
      value.operations.flatMap(op => (op.action === 'listing-unpublish' ? [op.id] : []))
    )
    value.operations.forEach((op, index) => {
      if (op.action === 'listing-slug-redirect' && unpublished.has(op.to.id))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'A redirect’s target cannot be unpublished in the same manifest.',
          path: ['operations', index, 'to']
        })
    })
  })
export type PublicationManifest = z.infer<typeof manifestSchema>
type Listing = z.infer<typeof listing>
export interface PlannedStatement {
  query: string
  bindings: unknown[]
}
export interface PublicationPlan {
  affectedRoutes: string
  afterChecksum: string
  /** The publication state the plan applies at: the manifest's, or the live one for `rows`. */
  base: PublicationBase
  inputChecksum: string
  manifest: PublicationManifest
  statements: PlannedStatement[]
}
export interface PublicationBase {
  checksum: string
  version: number
}
interface BatchStatement {
  bind(...values: unknown[]): BatchStatement
}
export interface PublicationDatabase {
  prepare(query: string): BatchStatement
  batch(statements: BatchStatement[]): Promise<unknown[]>
}

const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const statement = (query: string, ...bindings: unknown[]): PlannedStatement => ({ query, bindings })
/** The shared plan builders' statements (`{ sql, params }`) in the publisher's shape. */
const planned = (plans: readonly StatementPlan[]): PlannedStatement[] =>
  plans.map(plan => statement(plan.sql, ...plan.params))
function membershipGuard(id: string, expected: string[]): PlannedStatement {
  return statement(
    `SELECT CASE WHEN (SELECT COUNT(*) FROM listing_categories lc JOIN categories c ON c.id=lc.category_id WHERE lc.listing_id=? AND c.is_active=1)=? AND NOT EXISTS (SELECT 1 FROM listing_categories lc JOIN categories c ON c.id=lc.category_id WHERE lc.listing_id=? AND c.is_active=1 AND c.slug NOT IN (${expected.map(() => '?').join(', ')})) THEN 1 ELSE ${GUARD_FAILURE} END`,
    id,
    expected.length,
    id,
    ...expected
  )
}
/**
 * True while anything ties listing `?` to a person or a payment (#332), each in its open
 * statuses as `apps/web/src/db/schema.ts` defines them: a current owner (`listing_owners`), an
 * open claim (`openListingClaimStatuses`), an order on the listing or one of its submissions
 * that is pending, paid, or being refunded, an open revision (`openRevisionStatuses`), or a
 * submission that is not rejected or withdrawn (an approved free one is how the badge program
 * knows the listing's owner). Binds the listing id six times.
 */
export const LISTING_HAS_OWNERSHIP_RECORDS = `(EXISTS (SELECT 1 FROM listing_owners WHERE listing_id=? AND revoked_at IS NULL)
  OR EXISTS (SELECT 1 FROM listing_claims WHERE listing_id=? AND status IN ('code_sent','email_verified'))
  OR EXISTS (SELECT 1 FROM orders WHERE (listing_id=? OR submission_id IN (SELECT id FROM listing_submissions WHERE listing_id=?)) AND status IN ('pending','paid','refunding'))
  OR EXISTS (SELECT 1 FROM listing_revisions WHERE listing_id=? AND status IN ('pending_review','changes_requested'))
  OR EXISTS (SELECT 1 FROM listing_submissions WHERE listing_id=? AND status NOT IN ('rejected','withdrawn')))`
/** Refuses the batch unless the listing has this slug and exactly these categories, in order. */
function categoriesGuard(id: string, slug: string, expected: string[]): PlannedStatement {
  return statement(
    `SELECT CASE WHEN EXISTS (SELECT 1 FROM listings WHERE id=? AND slug=?) AND (SELECT json_group_array(slug) FROM (SELECT c.slug FROM listing_categories lc JOIN categories c ON c.id=lc.category_id WHERE lc.listing_id=? ORDER BY lc.sort_order, c.slug))=? THEN 1 ELSE ${GUARD_FAILURE} END`,
    id,
    slug,
    id,
    JSON.stringify(expected)
  )
}
/** Refuses the batch, with `reason`, unless the statement right before it changed one row. */
const changedOne = (reason: string): PlannedStatement =>
  statement(`SELECT CASE WHEN changes()=1 THEN 1 ELSE ${REASONED_GUARD_FAILURE} END`, reason)

/** The page a redirect target names: its own URL, or `/products/`. */
function targetRoute(target: TaxonomyTarget): string {
  if (target.kind === 'directory') return listingIndexRoute()
  if (target.kind === 'category') return categoryRoute(target.slug)
  return target.kind === 'tag' ? tagRoute(target.slug) : bestRoute(target.slug)
}
/** The routes a best page's pool shows on: its tag's page and its category's. */
function poolRoutes(page: { category: string | null; tag: string | null }): string[] {
  return [
    ...(page.tag === null ? [] : [tagRoute(page.tag)]),
    ...(page.category === null ? [] : [categoryRoute(page.category)])
  ]
}
function listingStatements(
  value: Listing,
  mode: 'create' | 'update',
  manifestId: string,
  now: string
): PlannedStatement[] {
  const out: PlannedStatement[] = []
  // Flags bind as 1 or 0: D1's REST API takes bindings as JSON, so a boolean would arrive as
  // true or false (#339 review).
  if (mode === 'create')
    out.push(
      // A new listing's outbound link is followed (#506), whatever the column's default.
      statement(
        "INSERT INTO listings (id,slug,name,description,website,content,entity_type,priority,is_unofficial,is_featured,link_rel,is_active,status,published_at,display_order,source_kind,source_identity,source_updated_at,checksum,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,'follow',1,'draft',?,(SELECT COALESCE(MAX(display_order),-1)+1 FROM listings),'yaml-manifest-v1',?,?,?,?,?)",
        value.id,
        value.slug,
        value.name,
        value.description,
        value.website,
        value.content ?? null,
        value.entityType ?? null,
        value.priority ?? null,
        value.isUnofficial ? 1 : 0,
        value.featured ? 1 : 0,
        value.publishedAt,
        manifestId,
        now,
        hash(JSON.stringify(value)),
        now,
        now
      )
    )
  else
    out.push(
      statement(
        "UPDATE listings SET status='draft' WHERE id=? AND slug=? AND status='approved' AND is_active=1",
        value.id,
        value.slug
      ),
      statement(CHANGED_ONE_GUARD),
      statement('DELETE FROM listing_categories WHERE listing_id=?', value.id),
      statement('DELETE FROM listing_media WHERE listing_id=?', value.id),
      // The manifest's media replace the listing's: no queued slot may overwrite them (#95).
      statement('DELETE FROM media_ingestions WHERE listing_id=?', value.id),
      statement('DELETE FROM listing_resource_links WHERE listing_id=?', value.id),
      statement('DELETE FROM listing_faqs WHERE listing_id=?', value.id),
      statement(
        "UPDATE listings SET name=?,description=?,website=?,content=?,entity_type=?,priority=?,is_unofficial=?,is_featured=?,is_active=1,published_at=?,source_kind='yaml-manifest-v1',source_identity=?,source_updated_at=?,checksum=?,updated_at=? WHERE id=?",
        value.name,
        value.description,
        value.website,
        value.content ?? null,
        value.entityType ?? null,
        value.priority ?? null,
        value.isUnofficial ? 1 : 0,
        value.featured ? 1 : 0,
        value.publishedAt,
        manifestId,
        now,
        hash(JSON.stringify(value)),
        now,
        value.id
      )
    )
  for (const [order, cat] of value.categories.entries())
    out.push(
      statement(
        'INSERT INTO listing_categories (listing_id,category_id,sort_order,is_primary) SELECT ?,id,?,? FROM categories WHERE slug=? AND is_active=1',
        value.id,
        order,
        order === 0 ? 1 : 0,
        cat
      )
    )
  out.push(
    statement(
      `SELECT CASE WHEN (SELECT COUNT(*) FROM listing_categories WHERE listing_id=?)=? THEN 1 ELSE ${GUARD_FAILURE} END`,
      value.id,
      value.categories.length
    )
  )
  const hostedRow = (kind: 'image' | 'logo', image: HostedImageEntry, order: number) =>
    statement(
      'INSERT INTO listing_media (listing_id,kind,url,sort_order,media_key,sha256,content_type,bytes,width,height) VALUES (?,?,?,?,?,?,?,?,?,?)',
      value.id,
      kind,
      image.source,
      order,
      image.key,
      image.sha256,
      image.contentType,
      image.bytes,
      image.width,
      image.height
    )
  if (value.media?.logo) out.push(hostedRow('logo', value.media.logo, 0))
  for (const [order, image] of (value.media?.images ?? []).entries())
    out.push(hostedRow('image', image, order))
  if (value.media?.video)
    out.push(
      statement(
        "INSERT INTO listing_media (listing_id,kind,url,sort_order) VALUES (?,'video',?,0)",
        value.id,
        value.media.video
      )
    )
  for (const [order, item] of (value.resources ?? []).entries())
    out.push(
      statement(
        'INSERT INTO listing_resource_links (listing_id,label,url,sort_order) VALUES (?,?,?,?)',
        value.id,
        item.label,
        item.url,
        order
      )
    )
  for (const [order, item] of (value.faqs ?? []).entries())
    out.push(
      statement(
        'INSERT INTO listing_faqs (listing_id,question,answer,sort_order) VALUES (?,?,?,?)',
        value.id,
        item.question,
        item.answer,
        order
      )
    )
  out.push(statement("UPDATE listings SET status='approved' WHERE id=?", value.id))
  return out
}
/** How a guard failure names a `listing-slug-redirect` operation. */
function redirectLabel(op: { from: { slug: string }; to: { slug: string } }): string {
  return `listing-slug-redirect ${op.from.slug} to ${op.to.slug}`
}
export const parseManifest = (source: string): PublicationManifest =>
  manifestSchema.parse(parse(source))

/**
 * A listing's logo and image rows as one JSON array of `[kind, url, media_key]`, ordered by kind
 * then sort order: what a `listing-media-update` compares and swaps on (`?` is the listing id).
 */
export const CURRENT_MEDIA_JSON = `(SELECT json_group_array(json_array(kind,url,media_key)) FROM (SELECT kind,url,media_key FROM listing_media WHERE listing_id=? AND kind IN ('logo','image') ORDER BY kind,sort_order))`

/**
 * A listing's resource links as one JSON array of `[label, url]`, in sort order: what a
 * `listing-resources-set` compares and swaps on (`?` is the listing id). `sort_order` is unique
 * per listing (`listing_resource_links_listing_order_unique`), so the order is total.
 */
const CURRENT_RESOURCES_JSON = `(SELECT json_group_array(json_array(label,url)) FROM (SELECT label,url FROM listing_resource_links WHERE listing_id=? ORDER BY sort_order))`

/** The JSON a listing's `expected` rows must equal (`CURRENT_MEDIA_JSON`). */
export function expectedMediaJson(rows: ExpectedMediaRow[]): string {
  return JSON.stringify(rows.map(row => [row.kind, row.url, row.key ?? null]))
}
/**
 * The base a manifest applies at: its own, or for a row-level manifest the live publication state
 * the publisher read (`live`), which it must supply.
 */
export function publicationBase(
  manifest: PublicationManifest,
  live?: PublicationBase
): PublicationBase {
  if (manifest.concurrency === 'rows') {
    if (!live?.checksum || !Number.isSafeInteger(live.version) || live.version < 0) {
      throw new Error('A row-level manifest is planned against the live publication state.')
    }
    return live
  }
  return {
    checksum: manifest.provenance.beforeChecksum ?? '',
    version: manifest.basePublicationVersion ?? -1
  }
}
/**
 * A taxonomy operation's statements (#341 design 4.1, #344), adding the pages it changes to
 * `routes`. The statements are the taxonomy's shared ones (`apps/web/src/db/taxonomy-plans.ts`),
 * which the admin panel builds too (#405): every guard runs before the write it protects, so a
 * refusal writes nothing, and every value is bound, the guards' reasons too.
 */
function taxonomyStatements(
  op: TaxonomyOperation,
  manifest: PublicationManifest,
  now: string,
  routes: Set<string>
): PlannedStatement[] {
  switch (op.action) {
    case 'tag-create':
      routes.add(tagRoute(op.tag.slug)).add(tagIndexRoute()).add(categoryRoute(op.tag.category))
      break
    case 'tag-update':
      routes
        .add(tagRoute(op.slug))
        .add(tagIndexRoute())
        .add(categoryRoute(op.expected.category))
        .add(categoryRoute(op.tag.category))
      break
    case 'tag-unpublish':
      routes.add(tagRoute(op.slug)).add(tagIndexRoute()).add(targetRoute(op.redirect))
      break
    case 'listing-tags-set':
      routes.add(listingRoute(op.slug)).add(tagIndexRoute())
      for (const tag of [...op.expected, ...op.tags]) routes.add(tagRoute(tag))
      break
    case 'best-page-create':
      routes.add(bestRoute(op.page.slug)).add(bestIndexRoute())
      for (const route of poolRoutes(op.page)) routes.add(route)
      break
    case 'best-page-update':
      routes.add(bestRoute(op.slug)).add(bestIndexRoute())
      for (const route of [...poolRoutes(op.expected), ...poolRoutes(op.page)]) routes.add(route)
      break
    case 'best-page-listings-set':
      routes.add(bestRoute(op.slug)).add(bestIndexRoute())
      break
    case 'best-page-unpublish':
      routes.add(bestRoute(op.slug)).add(bestIndexRoute()).add(targetRoute(op.redirect))
      break
    case 'taxonomy-redirect-set':
      routes.add(targetRoute(op.from)).add(targetRoute(op.to))
      break
  }
  return planned(
    taxonomyOperationStatements(op, {
      actor: manifest.provenance.actor,
      manifestId: manifest.id,
      now
    })
  )
}
export function buildPublicationPlan(
  manifest: PublicationManifest,
  source: string,
  now: string,
  live?: PublicationBase
): PublicationPlan {
  const base = publicationBase(manifest, live)
  const inputChecksum = hash(source)
  const afterChecksum = hash(`${base.checksum}\0${inputChecksum}`)
  const routes = new Set<string>()
  const addCategories = (values: string[]) => {
    for (const value of values) routes.add(categoryRoute(value))
  }
  const statements: PlannedStatement[] = [
    statement(
      `SELECT CASE WHEN COUNT(*)=1 AND MAX(version)=? AND MAX(checksum)=? THEN 1 ELSE ${GUARD_FAILURE} END FROM publication_state WHERE id=1`,
      base.version,
      base.checksum
    ),
    statement(
      "INSERT INTO publication_runs (id,manifest_id,base_version,input_checksum,outcome,started_at,actor,workflow,before_checksum,after_checksum) VALUES (?,?,?,?,'started',?,?,?,?,?) ON CONFLICT(manifest_id) DO UPDATE SET base_version=excluded.base_version,input_checksum=excluded.input_checksum,outcome='started',error=NULL,started_at=excluded.started_at,completed_at=NULL,actor=excluded.actor,workflow=excluded.workflow,before_checksum=excluded.before_checksum,after_checksum=excluded.after_checksum WHERE publication_runs.outcome='failed'",
      `publish_${hash(manifest.id).slice(0, 24)}`,
      manifest.id,
      base.version,
      inputChecksum,
      now,
      manifest.provenance.actor,
      manifest.provenance.workflow,
      base.checksum,
      afterChecksum
    )
  ]
  for (const op of manifest.operations) {
    if (isTaxonomyOperation(op)) {
      statements.push(...taxonomyStatements(op, manifest, now, routes))
      continue
    }
    if (op.action === 'category-create') {
      statements.push(...planned([categoryCreateStatement(op.category)]))
      addCategories([op.category.slug])
    }
    if (op.action === 'category-update') {
      statements.push(
        statement(
          'UPDATE categories SET name=?,description=?,sort_order=?,is_active=1,updated_at=? WHERE slug=?',
          op.category.name,
          op.category.description,
          op.category.order,
          now,
          op.category.slug
        ),
        statement(CHANGED_ONE_GUARD)
      )
      addCategories([op.category.slug])
    }
    if (op.action === 'category-unpublish') {
      statements.push(...planned(categoryUnpublishStatements(op.slug, now)))
      addCategories([op.slug])
    }
    if (op.action === 'listing-create' || op.action === 'listing-update') {
      if (op.action === 'listing-update') {
        statements.push(membershipGuard(op.listing.id, op.previousCategories))
        addCategories(op.previousCategories)
      } else {
        // Row-level (#506): the new listing's own row guards it, not a base version. Its id and
        // slug must be unused, and its website must not be another listing's, a submission's in
        // flight, or blocked, as for `listing-details-set`. `manifestSchema` has already refused
        // a non-public website.
        const { id, slug, website } = op.listing
        const label = `listing-create ${slug}`
        const conflicts = Object.values(listingWebsiteConflicts({ listingId: id, website }))
        statements.push(
          statement(
            `SELECT CASE WHEN EXISTS (SELECT 1 FROM listings WHERE id=? OR slug=?) THEN ${REASONED_GUARD_FAILURE} ELSE 1 END`,
            id,
            slug,
            `${label}: a listing already has this id or slug`
          ),
          statement(
            `SELECT CASE WHEN ${conflicts.map(conflict => conflict.sql).join(' OR ')} THEN ${REASONED_GUARD_FAILURE} ELSE 1 END`,
            ...conflicts.flatMap(conflict => conflict.params),
            `${label}: the website belongs to another listing or a submission in flight, or is blocked`
          )
        )
      }
      statements.push(
        ...listingStatements(
          op.listing,
          op.action === 'listing-create' ? 'create' : 'update',
          manifest.id,
          now
        )
      )
      routes.add(listingRoute(op.listing.slug))
      addCategories(op.listing.categories)
    }
    if (op.action === 'listing-unpublish') {
      const website = op.expected ? [op.expected.website] : []
      statements.push(
        membershipGuard(op.id, op.categories),
        // As in the admin panel (#64): never while the listing's own submission is in review.
        statement(
          `SELECT CASE WHEN ${listingHasQueuedSubmission('?')} THEN ${GUARD_FAILURE} ELSE 1 END`,
          op.id
        ),
        // #332: an owner, claim, order, revision, or submission would be stranded on the row.
        ...(op.expected?.unowned
          ? [
              statement(
                `SELECT CASE WHEN ${LISTING_HAS_OWNERSHIP_RECORDS} THEN ${GUARD_FAILURE} ELSE 1 END`,
                ...Array.from({ length: 6 }, () => op.id)
              )
            ]
          : []),
        statement(
          `UPDATE listings SET is_active=0,updated_at=? WHERE id=? AND slug=? AND status='approved' AND is_active=1${
            op.expected ? ' AND website=?' : ''
          }`,
          now,
          op.id,
          op.slug,
          ...website
        ),
        statement(CHANGED_ONE_GUARD),
        // The admin panel's activity records for an unpublish (#64).
        statement(
          "INSERT INTO listing_events (listing_id,event_type,detail,actor) VALUES (?,'unpublished',?,?)",
          op.id,
          JSON.stringify({ manifest: manifest.id, reason: op.reason ?? null }),
          manifest.provenance.actor
        ),
        statement(
          "INSERT INTO listing_submission_events (submission_id,event_type,detail,actor) SELECT id,'unpublished',?,? FROM listing_submissions WHERE listing_id=? AND status='approved'",
          op.reason ?? `manifest ${manifest.id}`,
          manifest.provenance.actor,
          op.id
        )
      )
      routes.add(listingRoute(op.slug))
      addCategories(op.categories)
    }
    if (op.action === 'listing-content-remove-suffix') {
      const keep = op.expected.contentLength - [...op.suffix].length
      statements.push(
        // As in the admin panel (#64): never while the listing's own submission is in review.
        statement(
          `SELECT CASE WHEN ${listingHasQueuedSubmission('?')} THEN ${GUARD_FAILURE} ELSE 1 END`,
          op.id
        ),
        // A new checksum, so a revision or admin edit read before this change is refused as stale.
        statement(
          "UPDATE listings SET content=substr(content,1,?),checksum=?,updated_at=? WHERE id=? AND slug=? AND status='approved' AND length(content)=? AND substr(content,?)=?",
          keep,
          hash(`${manifest.id}\0${op.id}\0content`),
          now,
          op.id,
          op.slug,
          op.expected.contentLength,
          keep + 1,
          op.suffix
        ),
        statement(CHANGED_ONE_GUARD),
        // The admin panel's activity record for an edit (#64).
        statement(
          "INSERT INTO listing_events (listing_id,event_type,detail,actor) VALUES (?,'edited',?,?)",
          op.id,
          JSON.stringify({ fields: ['content'], manifest: manifest.id, reason: op.reason }),
          manifest.provenance.actor
        )
      )
      routes.add(listingRoute(op.slug))
    }
    if (op.action === 'listing-claim-hold-add') {
      const website = op.expected ? [op.expected.website] : []
      statements.push(
        statement(
          `SELECT CASE WHEN EXISTS (SELECT 1 FROM listings WHERE id=? AND slug=?${
            op.expected ? ' AND website=?' : ''
          }) THEN 1 ELSE ${GUARD_FAILURE} END`,
          op.id,
          op.slug,
          ...website
        ),
        statement(
          'INSERT INTO listing_claim_holds (listing_id,reason,source,created_at) VALUES (?,?,?,?) ON CONFLICT(listing_id) DO UPDATE SET reason=excluded.reason,source=excluded.source,created_at=excluded.created_at,cleared_at=NULL,cleared_by=NULL WHERE listing_claim_holds.cleared_at IS NOT NULL',
          op.id,
          op.reason,
          `manifest ${manifest.id}: ${op.note}`,
          now
        ),
        statement(
          `SELECT CASE WHEN EXISTS (SELECT 1 FROM listing_claim_holds WHERE listing_id=? AND cleared_at IS NULL) THEN 1 ELSE ${GUARD_FAILURE} END`,
          op.id
        )
      )
      routes.add(listingRoute(op.slug))
    }
    if (op.action === 'listing-claim-hold-clear') {
      if (op.expected)
        statements.push(
          statement(
            `SELECT CASE WHEN EXISTS (SELECT 1 FROM listings WHERE id=? AND slug=? AND website=?) THEN 1 ELSE ${REASONED_GUARD_FAILURE} END`,
            op.id,
            op.slug,
            op.expected.website,
            `listing-claim-hold-clear ${op.slug}: its website is not ${op.expected.website} yet; publish the manifest that sets it first`
          )
        )
      statements.push(
        statement(
          'UPDATE listing_claim_holds SET cleared_at=?,cleared_by=? WHERE listing_id=? AND cleared_at IS NULL AND EXISTS (SELECT 1 FROM listings WHERE id=? AND slug=?)',
          now,
          `${manifest.provenance.actor} (manifest ${manifest.id}: ${op.note})`.slice(0, 300),
          op.id,
          op.id,
          op.slug
        ),
        statement(CHANGED_ONE_GUARD)
      )
      routes.add(listingRoute(op.slug))
    }
    if (op.action === 'listing-categories-remove') {
      statements.push(
        categoriesGuard(op.id, op.slug, op.expected),
        ...op.remove.flatMap(categorySlugToRemove => [
          // `is_primary=0`: a primary category is never removed, the batch refuses instead.
          statement(
            'DELETE FROM listing_categories WHERE listing_id=? AND is_primary=0 AND category_id=(SELECT id FROM categories WHERE slug=?)',
            op.id,
            categorySlugToRemove
          ),
          statement(CHANGED_ONE_GUARD)
        ]),
        // The page shows its categories, so it changed: sitemap lastmod and dateModified (#218).
        statement('UPDATE listings SET updated_at=? WHERE id=?', now, op.id),
        statement(CHANGED_ONE_GUARD)
      )
      routes.add(listingRoute(op.slug))
      addCategories(op.expected)
    }
    if (op.action === 'listing-categories-add') {
      statements.push(
        categoriesGuard(op.id, op.slug, op.expected),
        ...op.add.flatMap(categorySlugToAdd => [
          statement(
            'INSERT INTO listing_categories (listing_id,category_id,sort_order,is_primary) SELECT ?,id,(SELECT COALESCE(MAX(sort_order),-1)+1 FROM listing_categories WHERE listing_id=?),0 FROM categories WHERE slug=? AND is_active=1',
            op.id,
            op.id,
            categorySlugToAdd
          ),
          statement(CHANGED_ONE_GUARD)
        ]),
        // The page shows its categories, so it changed: sitemap lastmod and dateModified (#218).
        statement('UPDATE listings SET updated_at=? WHERE id=?', now, op.id),
        statement(CHANGED_ONE_GUARD)
      )
      routes.add(listingRoute(op.slug))
      addCategories([...op.expected, ...op.add])
    }
    if (op.action === 'listing-categories-set') {
      statements.push(
        categoriesGuard(op.id, op.slug, op.expected),
        // As in the admin panel (#64): never while the listing's own submission is in review. Its
        // approval needs the checksum the listing was paid at (`published_checksum`), and the new
        // checksum below would leave that paid submission impossible to approve.
        statement(
          `SELECT CASE WHEN ${listingHasQueuedSubmission('?')} THEN ${GUARD_FAILURE} ELSE 1 END`,
          op.id
        ),
        // A draft while its memberships are replaced, as the admin panel's edit does: the
        // primary-category triggers refuse removing a published listing's primary.
        statement(
          "UPDATE listings SET status='draft' WHERE id=? AND slug=? AND status='approved'",
          op.id,
          op.slug
        ),
        statement(CHANGED_ONE_GUARD),
        statement('DELETE FROM listing_categories WHERE listing_id=?', op.id),
        // The first is the primary. A missing or retired category inserts nothing: refused.
        // `is_primary` binds as 1 or 0, never a boolean, so D1's REST API binds it as the
        // Worker binding does (`d1-remote-publisher.ts` sends bindings as JSON).
        ...op.categories.flatMap((categorySlugToSet, order) => [
          statement(
            'INSERT INTO listing_categories (listing_id,category_id,sort_order,is_primary) SELECT ?,id,?,? FROM categories WHERE slug=? AND is_active=1',
            op.id,
            order,
            order === 0 ? 1 : 0,
            categorySlugToSet
          ),
          statement(CHANGED_ONE_GUARD)
        ]),
        // Published again: the triggers check exactly one primary and no retired category. The
        // page shows its categories, so it changed (sitemap lastmod, #218), and a new checksum
        // refuses an admin edit or revision read before it, which would put the old primary back.
        statement(
          "UPDATE listings SET status='approved',checksum=?,updated_at=? WHERE id=? AND status='draft'",
          hash(`${manifest.id}\0${op.id}\0categories`),
          now,
          op.id
        ),
        statement(CHANGED_ONE_GUARD),
        // The admin panel's activity record for an edit (#64).
        statement(
          "INSERT INTO listing_events (listing_id,event_type,detail,actor) VALUES (?,'edited',?,?)",
          op.id,
          JSON.stringify({
            fields: ['categories'],
            manifest: manifest.id,
            from: op.expected,
            to: op.categories
          }),
          manifest.provenance.actor
        )
      )
      routes.add(listingRoute(op.slug))
      addCategories([...op.expected, ...op.categories])
    }
    if (op.action === 'listing-details-set') {
      const next = { ...op.expected, ...op.details }
      const website = op.details.website
      const label = `listing-details-set ${op.slug}`
      // A new website must not be another listing's, a submission's in flight, or blocked.
      const conflicts = website
        ? Object.values(listingWebsiteConflicts({ listingId: op.id, website }))
        : []
      statements.push(
        // As in the admin panel (#64): never while the listing's own submission is in review, whose
        // approval needs the checksum the listing was paid at.
        statement(
          `SELECT CASE WHEN ${listingHasQueuedSubmission('?')} THEN ${REASONED_GUARD_FAILURE} ELSE 1 END`,
          op.id,
          `${label}: its own submission is in review`
        ),
        // As in the admin panel: a listing whose own submission stands rejected stays down and
        // read-only (`docs/admin-panel.md`). Its row is still `approved`, with `is_active=0`.
        statement(
          `SELECT CASE WHEN ${listingSubmissionRejected('?')} THEN ${REASONED_GUARD_FAILURE} ELSE 1 END`,
          op.id,
          `${label}: its own submission was rejected`
        ),
        ...(conflicts.length > 0
          ? [
              statement(
                `SELECT CASE WHEN ${conflicts.map(conflict => conflict.sql).join(' OR ')} THEN ${REASONED_GUARD_FAILURE} ELSE 1 END`,
                ...conflicts.flatMap(conflict => conflict.params),
                `${label}: the new website belongs to another listing or a submission in flight, or is blocked`
              )
            ]
          : []),
        // Compared and swapped on all three fields. The page changed, so `updated_at` (sitemap
        // lastmod, #218) moves, and a new checksum refuses an admin edit or revision read before it.
        statement(
          "UPDATE listings SET name=?,description=?,website=?,checksum=?,updated_at=? WHERE id=? AND slug=? AND status='approved' AND name=? AND description=? AND website=?",
          next.name,
          next.description,
          next.website,
          hash(`${manifest.id}\0${op.id}\0details`),
          now,
          op.id,
          op.slug,
          op.expected.name,
          op.expected.description,
          op.expected.website
        ),
        statement(
          `SELECT CASE WHEN changes()=1 THEN 1 ELSE ${REASONED_GUARD_FAILURE} END`,
          `${label}: the listing is not approved, or its slug, name, description, or website changed since the manifest`
        ),
        // The admin panel's activity record for an edit (#64): "Details edited: name, ...".
        statement(
          "INSERT INTO listing_events (listing_id,event_type,detail,actor) VALUES (?,'edited',?,?)",
          op.id,
          JSON.stringify({
            fields: listingDetailFields.filter(field => op.details[field] !== undefined),
            manifest: manifest.id,
            reason: op.reason
          }),
          manifest.provenance.actor
        )
      )
      routes.add(listingRoute(op.slug))
    }
    if (op.action === 'listing-resources-set') {
      const label = `listing-resources-set ${op.slug}`
      statements.push(
        // As in the admin panel (#64): never while the listing's own submission is in review, whose
        // approval needs the checksum the listing was paid at; the new checksum below changes it.
        statement(
          `SELECT CASE WHEN ${listingHasQueuedSubmission('?')} THEN ${REASONED_GUARD_FAILURE} ELSE 1 END`,
          op.id,
          `${label}: its own submission is in review`
        ),
        // As in the admin panel: a listing whose own submission stands rejected stays read-only.
        statement(
          `SELECT CASE WHEN ${listingSubmissionRejected('?')} THEN ${REASONED_GUARD_FAILURE} ELSE 1 END`,
          op.id,
          `${label}: its own submission was rejected`
        ),
        // Compared and swapped on the slug and every link, in order. The page changed, so
        // `updated_at` (sitemap lastmod, #218) moves, and a new checksum refuses an owner revision
        // or admin edit read before it: a revision's approval replaces the links with its own.
        statement(
          `UPDATE listings SET checksum=?,updated_at=? WHERE id=? AND slug=? AND status='approved' AND ${CURRENT_RESOURCES_JSON}=?`,
          hash(`${manifest.id}\0${op.id}\0resources`),
          now,
          op.id,
          op.slug,
          op.id,
          JSON.stringify(op.expected.map(link => [link.label, link.url]))
        ),
        changedOne(
          `${label}: the listing is not approved, or its slug or links changed since the manifest`
        ),
        statement('DELETE FROM listing_resource_links WHERE listing_id=?', op.id),
        ...op.resources.map((link, order) =>
          statement(
            'INSERT INTO listing_resource_links (listing_id,label,url,sort_order) VALUES (?,?,?,?)',
            op.id,
            link.label,
            link.url,
            order
          )
        ),
        // The admin panel's activity record for an edit (#64): "Details edited: links".
        statement(
          "INSERT INTO listing_events (listing_id,event_type,detail,actor) VALUES (?,'edited',?,?)",
          op.id,
          JSON.stringify({ fields: ['links'], manifest: manifest.id, reason: op.reason }),
          manifest.provenance.actor
        )
      )
      routes.add(listingRoute(op.slug))
    }
    if (op.action === 'listing-feature-listing-set') {
      statements.push(
        // Compared and swapped on the slug and the flag. No public page changes, so neither the
        // checksum nor `updated_at` (sitemap lastmod) moves, and no route is recorded. Bound as
        // 1 or 0: D1's REST API takes bindings as JSON, where a boolean isn't a SQLite integer.
        statement(
          "UPDATE listings SET is_feature_listing=? WHERE id=? AND slug=? AND status='approved' AND is_feature_listing=?",
          op.featureListing ? 1 : 0,
          op.id,
          op.slug,
          op.expected ? 1 : 0
        ),
        changedOne(
          `listing-feature-listing-set ${op.slug}: the listing is not approved, or its slug or feature flag changed since the manifest`
        ),
        // The admin panel's activity record for an edit (#64): "Details edited: feature listing".
        statement(
          "INSERT INTO listing_events (listing_id,event_type,detail,actor) VALUES (?,'edited',?,?)",
          op.id,
          JSON.stringify({ fields: ['feature listing'], manifest: manifest.id, reason: op.reason }),
          manifest.provenance.actor
        )
      )
    }
    if (op.action === 'listing-media-update') {
      const expected = expectedMediaJson(op.expected)
      // The rows it writes: the logo at sort order 0, and its images at 0..n-1.
      const written = [
        ...(op.media.logo ? [['logo', op.media.logo, 0] as const] : []),
        ...(op.media.images ?? []).map((image, order) => ['image', image, order] as const)
      ]
      // The slots it replaces: those it writes with new media, neither the same source nor the
      // same bytes as a row the listing already has of that kind. A re-host of an old row (a
      // renamed listing's follow-up, whose source may be the old slug's CDN copy, as in #337's
      // moves between slugs) would revert a newer upload queued at its position, not replace it
      // (#458 review). Same bytes: the row's key carries the digest prefix that `hostedImage`
      // holds the written key to; an imported row with no key matches on its source only. Any
      // other queued slot is one the `DELETE` below would drop.
      const rehost = (kind: string, image: HostedImageEntry) =>
        op.expected.some(
          row =>
            row.kind === kind &&
            (row.url === image.source ||
              (row.key !== null &&
                parseMediaKey(row.key)?.hash === image.sha256.slice(0, MEDIA_HASH_LENGTH)))
        )
      const replaced = written
        .filter(([kind, image]) => !rehost(kind, image))
        .map(([kind, , order]) => `${kind} ${order}`)
      const dropped = `media_ingestions WHERE listing_id=? AND kind IN ('logo','image') AND kind || ' ' || sort_order NOT IN (SELECT value FROM json_each(?))`
      const droppedParams = [op.id, JSON.stringify(replaced)]
      statements.push(
        statement(
          `SELECT CASE WHEN EXISTS (SELECT 1 FROM listings WHERE id=? AND slug=?) AND ${CURRENT_MEDIA_JSON}=? THEN 1 ELSE ${GUARD_FAILURE} END`,
          op.id,
          op.slug,
          op.id,
          expected
        ),
        // `expected` lists `listing_media` rows, never a queued upload, so a pending or failed
        // slot is one this update was not generated against: an approval's new logo or image, or
        // an admin's new logo whose first fetch failed, waits in the queue until the cron hosts
        // it, and a renamed listing's update names only the rows it had (#336, #458). Refuse
        // rather than drop it below, naming the slot (its reviewed pending key, or the source an
        // admin queued) and what to do. The reason is never NULL, so it fails like
        // `REASONED_GUARD_FAILURE`.
        statement(
          `SELECT CASE WHEN EXISTS (SELECT 1 FROM ${dropped}) THEN json_extract('{}', ? || COALESCE((SELECT group_concat(kind || ' ' || COALESCE(copy_from_key,source_url) || ' (' || status || ')', ', ') FROM (SELECT kind,copy_from_key,source_url,status FROM ${dropped} ORDER BY kind,sort_order)),'') || ?) ELSE 1 END`,
          ...droppedParams,
          `listing-media-update ${op.slug} (${op.id}) would drop a pending or failed upload it does not replace: `,
          ...droppedParams,
          '. Let the media cron host a pending one, or host a failed one with a media upload plan, then ship an update that names it (docs/media.md)'
        ),
        statement(
          "DELETE FROM listing_media WHERE listing_id=? AND kind IN ('logo','image')",
          op.id
        ),
        statement(
          "DELETE FROM media_ingestions WHERE listing_id=? AND kind IN ('logo','image')",
          op.id
        ),
        ...written.map(([kind, image, order]) =>
          statement(
            'INSERT INTO listing_media (listing_id,kind,url,sort_order,media_key,sha256,content_type,bytes,width,height) VALUES (?,?,?,?,?,?,?,?,?,?)',
            op.id,
            kind,
            image.source,
            order,
            image.key,
            image.sha256,
            image.contentType,
            image.bytes,
            image.width,
            image.height
          )
        )
        // No `updated_at` (#218): these manifests re-host the same logo and images, as the media
        // cron does, so the page looks the same and its lastmod should not move.
      )
      routes.add(listingRoute(op.slug))
    }
    if (op.action === 'listing-slug-change') {
      statements.push(
        membershipGuard(op.id, op.categories),
        statement(
          "UPDATE listings SET slug=?,updated_at=? WHERE id=? AND slug=? AND status='approved' AND is_active=1 AND NOT EXISTS (SELECT 1 FROM listings conflict WHERE conflict.slug=?)",
          op.to,
          now,
          op.id,
          op.from,
          op.to
        ),
        statement(CHANGED_ONE_GUARD),
        statement(
          'INSERT INTO listing_slug_redirects (listing_id,old_slug,new_slug,manifest_id,reason,created_at) VALUES (?,?,?,?,?,?)',
          op.id,
          op.from,
          op.to,
          manifest.id,
          op.reason,
          now
        )
      )
      routes.add(listingRoute(op.from))
      routes.add(listingRoute(op.to))
      addCategories(op.categories)
    }
    if (op.action === 'listing-slug-redirect') {
      const redirect = redirectLabel(op)
      statements.push(
        // The source: unpublished, exactly as its slug answers 410 today
        // (`isUnpublishedListingSlug`). One filed under a retired category answers 404 and stays
        // there: #260 sends no adult listing's traffic elsewhere. Its row is never changed.
        statement(
          `SELECT CASE WHEN EXISTS (SELECT 1 FROM listings WHERE id=? AND slug=? AND status='approved' AND is_active=0 AND published_at IS NOT NULL) AND NOT ${listingInRetiredCategory('?')} THEN 1 ELSE ${REASONED_GUARD_FAILURE} END`,
          op.from.id,
          op.from.slug,
          op.from.id,
          `${redirect}: the source is not this unpublished listing, or is filed under a retired category`
        ),
        // The target: public now, by the predicates the product page's redirect lookup applies.
        statement(
          `SELECT CASE WHEN EXISTS (SELECT 1 FROM listings WHERE id=? AND slug=? AND status='approved' AND is_active=1 AND published_at IS NOT NULL AND published_at<=?) THEN 1 ELSE ${REASONED_GUARD_FAILURE} END`,
          op.to.id,
          op.to.slug,
          now,
          `${redirect}: the target is not this live listing`
        ),
        // No redirect for the slug yet; no chain or loop: the target's slug isn't redirected, and
        // no older slug redirects to the source.
        statement(
          `SELECT CASE WHEN EXISTS (SELECT 1 FROM listing_slug_redirects WHERE old_slug IN (?, ?) OR listing_id=?) THEN ${REASONED_GUARD_FAILURE} ELSE 1 END`,
          op.from.slug,
          op.to.slug,
          op.from.id,
          `${redirect}: the slug already redirects, or this would make a chain or a loop`
        ),
        statement(
          'INSERT INTO listing_slug_redirects (listing_id,old_slug,new_slug,manifest_id,reason,created_at) VALUES (?,?,?,?,?,?)',
          op.to.id,
          op.from.slug,
          op.to.slug,
          manifest.id,
          op.reason,
          now
        )
      )
      // The source's page turns from 410 to 308; the target's page is unchanged.
      routes.add(listingRoute(op.from.slug))
    }
  }
  // #338 review: each redirect still holds once every operation of the batch ran. A later
  // `category-unpublish` could retire its source's category (that listing answers 404, #260), and
  // a later `listing-update` could leave its target unpublished or not yet due. Either refuses the
  // whole batch, in whichever order the manifest lists them.
  for (const op of manifest.operations) {
    if (op.action !== 'listing-slug-redirect') continue
    statements.push(
      statement(
        `SELECT CASE WHEN EXISTS (SELECT 1 FROM listings WHERE id=? AND status='approved' AND is_active=0 AND published_at IS NOT NULL) AND NOT ${listingInRetiredCategory('?')} AND EXISTS (SELECT 1 FROM listings WHERE id=? AND status='approved' AND is_active=1 AND published_at IS NOT NULL AND published_at<=?) THEN 1 ELSE ${REASONED_GUARD_FAILURE} END`,
        op.from.id,
        op.from.id,
        op.to.id,
        now,
        `${redirectLabel(op)}: by the end of the batch, its source is no longer unpublished outside retired categories, or its target is no longer live`
      )
    )
  }
  const affectedRoutes = [
    ...new Set([
      ...routes,
      '/',
      listingIndexRoute(),
      '/search/',
      ...catalogSitemapRoutes({ taxonomy: manifest.operations.some(isTaxonomyOperation) }),
      '/rss.xml'
    ])
  ]
    .sort()
    .join('\n')
  statements.push(
    ...planned(taxonomyBatchChecks(manifest.operations.filter(isTaxonomyOperation))),
    statement(
      'UPDATE publication_state SET version=?,manifest_id=?,checksum=?,published_at=? WHERE id=1 AND version=? AND checksum=?',
      base.version + 1,
      manifest.id,
      afterChecksum,
      now,
      base.version,
      base.checksum
    ),
    statement(CHANGED_ONE_GUARD),
    statement(
      "UPDATE publication_runs SET published_version=?,affected_records=?,affected_routes=?,outcome='succeeded',completed_at=? WHERE manifest_id=? AND before_checksum=? AND after_checksum=?",
      base.version + 1,
      manifest.operations.length,
      affectedRoutes,
      now,
      manifest.id,
      base.checksum,
      afterChecksum
    )
  )
  // A statement D1's remote API would refuse never leaves the planner (#95 release blocker).
  assertD1Compatible(statements)
  return { affectedRoutes, afterChecksum, base, inputChecksum, manifest, statements }
}
export async function executePublicationPlan(
  database: PublicationDatabase,
  plan: PublicationPlan
): Promise<void> {
  await database.batch(
    plan.statements.map(item => database.prepare(item.query).bind(...item.bindings))
  )
}
export function publishManifest(manifestPath: string): void {
  const source = readFileSync(resolve(manifestPath), 'utf8')
  const manifest = parseManifest(source)
  validateCanonicalLocalConfig()
  buildPublicationPlan(manifest, source, new Date().toISOString())
  throw new Error(
    'CLI publication is disabled: an atomic D1Database.batch binding is required. The manifest was validated but no changes were made.'
  )
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (!process.argv[2]) throw new Error('Manifest path is required.')
  publishManifest(process.argv[2])
}

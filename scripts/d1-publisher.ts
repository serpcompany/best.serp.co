import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { z } from 'zod'
import { IMAGE_CONTENT_TYPES, MAX_IMAGE_SIDE } from '../apps/web/src/db/media-format'
import {
  contentTypeForKey,
  MAX_MEDIA_BYTES,
  MEDIA_HASH_LENGTH,
  parseMediaKey
} from '../apps/web/src/db/media-keys'
import { listingHasQueuedSubmission } from '../apps/web/src/db/plan-support'
import { BEST_PAGE_LIST_SIZE, taxonomyRedirectSourceKinds } from '../apps/web/src/db/schema'
import { hasFileExtension } from '../apps/web/src/lib/seo/canonical-url'
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
 * to fix. The reason is a constant of the plan, never a binding.
 */
export function guardFailure(reason: string): string {
  return `json_extract('{}', '${reason.replaceAll("'", "''")}')`
}

/** A slug that already exists; renaming or unpublishing it must stay possible. */
const existingSlug = z.string().regex(/^[a-z0-9.-]+$/)
// A listing page is `/products/<slug>/`; a slug ending in a file extension (`chart.js`) would
// make it a file URL without its trailing slash, so a published slug never ends in one.
// Category slugs have no dots.
const slug = existingSlug.refine(value => !hasFileExtension(value), {
  message: 'A listing slug cannot end in a file extension; its page would be served as a file.'
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
 * The taxonomy (#341): tags and best pages are written only by manifests (design 4.1). Their
 * slugs have a category's shape: `/products/tags/<slug>/` and `/best/<slug>/`.
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
type BestPageState = z.infer<typeof bestPageState>
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
/** A best page's pins as its guard compares them: `[id, slug, blurb]` in position order. */
const pinsJson = (pins: BestPageListings['pins']): string =>
  JSON.stringify(pins.map(pin => [pin.id, pin.slug, pin.blurb ?? null]))
/** A best page's exclusions as its guard compares them: `[id, slug]` ordered by id. */
const exclusionsJson = (exclude: BestPageListings['exclude']): string =>
  JSON.stringify(
    exclude
      .map(entry => [entry.id, entry.slug])
      .sort(([a = ''], [b = '']) => (a < b ? -1 : a > b ? 1 : 0))
  )
/**
 * The `best_pages` columns a best page's state writes, each with its value's SQL, bound from
 * `bestPageColumns` in this order. A null tag or category binds null, so its id is null.
 */
const BEST_PAGE_WRITES = {
  keyword: '?',
  title: '?',
  heading: '?',
  intro: '?',
  tag_id: '(SELECT id FROM tags WHERE slug=?)',
  category_id: '(SELECT id FROM categories WHERE slug=?)',
  list_size: '?',
  keyword_volume: '?',
  keyword_checked_at: '?',
  sort_order: '?'
} as const
/** A best page's state in `BEST_PAGE_WRITES` order, as `best-page-update` compares and writes it. */
const bestPageColumns = (page: BestPageState) => [
  page.keyword,
  page.title,
  page.heading,
  page.intro,
  page.tag,
  page.category,
  page.listSize,
  page.keywordVolume,
  page.keywordCheckedAt,
  page.order
]
/** A redirect target as `[kind, slug]`, the shape its guard compares (`slug` null for `/products/`). */
function targetPair(target: TaxonomyTarget): [string, string | null] {
  return [target.kind, target.kind === 'directory' ? null : target.slug]
}
const sameTarget = (a: TaxonomyTarget | null, b: TaxonomyTarget | null): boolean =>
  JSON.stringify(a && targetPair(a)) === JSON.stringify(b && targetPair(b))
const resource = z.object({ label: z.string().min(1), url: z.string().url() }).strict()
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
const operation = z.discriminatedUnion('action', [
  z.object({ action: z.literal('listing-create'), listing }).strict(),
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
   * Replaces a listing's logo and images with hosted copies (#95). `expected` is the listing's
   * logo and image rows (kind, source url, and hosted key, ordered by kind then sort order) when
   * the manifest was generated: the batch refuses a listing whose media changed since (a
   * row-level compare-and-swap, so the operation fits any environment whose rows match). Keys
   * belong to the slug. The listing's queued media slots are dropped: the manifest wins.
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
  /** Clears a listing's active claim hold (#67): the owner decided it can be claimed. */
  z
    .object({
      action: z.literal('listing-claim-hold-clear'),
      id: listingId,
      slug: existingSlug,
      note: z.string().trim().min(1).max(200)
    })
    .strict(),
  z.object({ action: z.literal('category-create'), category }).strict(),
  z.object({ action: z.literal('category-update'), category }).strict(),
  /**
   * Retires a category (`is_active = 0`): it leaves the navigation, the category index, the
   * sitemaps, search, and the submit and edit forms, its page answers 404, and so do its
   * unpublished listings (#260). Refused while any live listing remains in it, primary or
   * secondary, so it follows the unpublish operations of its listings. That guard is its own
   * row-level check, so a `rows` manifest may hold it (#260: the Adult category).
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
   * target is missing or retired.
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
   * is re-pointed there, so redirects never chain. Refused when the target is missing or retired.
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
   * for none. Refused when the current target isn't `expected`, or the target is missing or retired.
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
 * category retirement (#260: no live listing left in it), a new category (#333: its insert
 * refuses the batch when the slug exists, retired or not), and every taxonomy operation (#344:
 * each compares the tag, best page, listing, or redirect it changes).
 */
const rowLevelActions = new Set<string>([
  'listing-media-update',
  'listing-categories-add',
  'listing-categories-remove',
  'listing-categories-set',
  'listing-content-remove-suffix',
  'listing-unpublish',
  'listing-claim-hold-add',
  'listing-claim-hold-clear',
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
              'A row-level manifest holds only listing-media-update, listing-categories-add/-remove/-set, listing-content-remove-suffix, listing-unpublish, listing-claim-hold-add/-clear, category-create/-unpublish, and taxonomy (tag-*, listing-tags-set, best-page-*, taxonomy-redirect-set) operations.',
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
      const id =
        op.action === 'listing-create' || op.action === 'listing-update' ? op.listing.id : op.id
      const target =
        op.action === 'listing-create' || op.action === 'listing-update'
          ? op.listing.slug
          : op.action === 'listing-slug-change'
            ? op.to
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
/**
 * Taxonomy guards (#344) refuse with their reason (`guardFailure`): a batch of thousands of
 * operations names the one that failed, and why.
 */
function guard(condition: string, reason: string, ...bindings: unknown[]): PlannedStatement {
  return statement(
    `SELECT CASE WHEN ${condition} THEN 1 ELSE ${guardFailure(reason)} END`,
    ...bindings
  )
}
/** Refuses the batch, with `reason`, unless the statement right before it changed one row. */
const changedOne = (reason: string): PlannedStatement =>
  statement(`SELECT CASE WHEN changes()=1 THEN 1 ELSE ${guardFailure(reason)} END`)

const TAXONOMY_TABLES = { best: 'best_pages', category: 'categories', tag: 'tags' } as const
const TARGET_ID_COLUMNS = {
  best: 'target_best_page_id',
  category: 'target_category_id',
  tag: 'target_tag_id'
} as const
/** A listing's tags as `listing-tags-set` compares them: slugs by sort order, then slug. */
const CURRENT_TAGS_JSON =
  '(SELECT json_group_array(slug) FROM (SELECT t.slug FROM listing_tags lt JOIN tags t ON t.id=lt.tag_id WHERE lt.listing_id=? ORDER BY lt.sort_order, t.slug))'
/** A redirect source's current target as `[kind, slug]` (`slug` null for `/products/`), or null. */
const CURRENT_REDIRECT_TARGET =
  '(SELECT json_array(r.target_kind, COALESCE(c.slug, t.slug, b.slug)) FROM taxonomy_redirects r LEFT JOIN categories c ON c.id=r.target_category_id LEFT JOIN tags t ON t.id=r.target_tag_id LEFT JOIN best_pages b ON b.id=r.target_best_page_id WHERE r.source_kind=? AND r.source_slug=?)'
/** A best page's pins (`?` its slug), compared with `pinsJson`. */
const CURRENT_PINS_JSON =
  '(SELECT json_group_array(json_array(id, slug, blurb)) FROM (SELECT l.id, l.slug, bpl.blurb FROM best_page_listings bpl JOIN best_pages b ON b.id=bpl.best_page_id JOIN listings l ON l.id=bpl.listing_id WHERE b.slug=? AND bpl.excluded=0 ORDER BY bpl.position))'
/** A best page's exclusions (`?` its slug), compared with `exclusionsJson`. */
const CURRENT_EXCLUSIONS_JSON =
  '(SELECT json_group_array(json_array(id, slug)) FROM (SELECT l.id, l.slug FROM best_page_listings bpl JOIN best_pages b ON b.id=bpl.best_page_id JOIN listings l ON l.id=bpl.listing_id WHERE b.slug=? AND bpl.excluded=1 ORDER BY l.id))'

/** The page a redirect target names: its own URL, or `/products/`. */
function targetRoute(target: TaxonomyTarget): string {
  if (target.kind === 'directory') return listingIndexRoute()
  if (target.kind === 'category') return categoryRoute(target.slug)
  return target.kind === 'tag' ? tagRoute(target.slug) : bestRoute(target.slug)
}
/** The id of slug `?` in `table`, or NULL for a column the target doesn't set. */
const idOf = (table: string, set: boolean) =>
  set ? `(SELECT id FROM ${table} WHERE slug=?)` : 'NULL'
/**
 * A redirect target's columns, `target_kind` then the category, tag, and best page ids, as SQL
 * expressions and their bindings. Exactly the target's own id is set, as the table's CHECK
 * requires; the guards have already found it active.
 */
function targetColumns(target: TaxonomyTarget): { bindings: unknown[]; sql: string[] } {
  return {
    bindings: [target.kind, ...(target.kind === 'directory' ? [] : [target.slug])],
    sql: [
      '?',
      idOf('categories', target.kind === 'category'),
      idOf('tags', target.kind === 'tag'),
      idOf('best_pages', target.kind === 'best')
    ]
  }
}
const KIND_NOUNS = { best: 'best page', category: 'category', tag: 'tag' } as const
/**
 * Refuses the batch unless `target` is an active category, tag, or best page (`/products/`
 * always is). `role` names it in the reason: a redirect's target, a best page's pool, a tag's hub.
 */
function targetActiveGuard(
  target: TaxonomyTarget,
  label: string,
  role = 'the redirect target'
): PlannedStatement[] {
  if (target.kind === 'directory') return []
  return [
    guard(
      `EXISTS (SELECT 1 FROM ${TAXONOMY_TABLES[target.kind]} WHERE slug=? AND is_active=1)`,
      `${label}: ${role} ${KIND_NOUNS[target.kind]} ${target.slug} is missing or retired`,
      target.slug
    )
  ]
}
/** Inserts the redirect of `kind` `slug` to `target`; the caller has removed any earlier one. */
function insertRedirect(
  kind: string,
  slug: string,
  target: TaxonomyTarget,
  manifestId: string,
  now: string
): PlannedStatement {
  const columns = targetColumns(target)
  return statement(
    `INSERT INTO taxonomy_redirects (source_kind,source_slug,target_kind,target_category_id,target_tag_id,target_best_page_id,manifest_id,created_at) VALUES (?,?,${columns.sql.join(',')},?,?)`,
    kind,
    slug,
    ...columns.bindings,
    manifestId,
    now
  )
}
/**
 * Retires the active tag or best page `slug` (`tag-unpublish`, `best-page-unpublish`) and sends
 * its URL to `target`, which must be active. Every redirect aimed at it is re-pointed to the same
 * target, so a redirect never leads to a retired page or through a second hop (design 2.2). A
 * redirect from the target's own URL would then point at itself, so it is removed instead: while
 * the target is active its page renders, and if it retires later, its own retirement writes the
 * redirect for that URL.
 */
function retireWithRedirect(
  kind: 'best' | 'tag',
  slug: string,
  target: TaxonomyTarget,
  label: string,
  manifestId: string,
  now: string
): PlannedStatement[] {
  const table = TAXONOMY_TABLES[kind]
  const column = TARGET_ID_COLUMNS[kind]
  const columns = targetColumns(target)
  return [
    ...targetActiveGuard(target, label),
    statement(
      `UPDATE ${table} SET is_active=0,updated_at=? WHERE slug=? AND is_active=1`,
      now,
      slug
    ),
    changedOne(`${label}: no active ${KIND_NOUNS[kind]} has this slug`),
    ...(target.kind === 'directory'
      ? []
      : [
          statement(
            `DELETE FROM taxonomy_redirects WHERE source_kind=? AND source_slug=? AND ${column}=(SELECT id FROM ${table} WHERE slug=?)`,
            target.kind,
            target.slug,
            slug
          )
        ]),
    statement(
      `UPDATE taxonomy_redirects SET target_kind=${columns.sql[0]},target_category_id=${columns.sql[1]},target_tag_id=${columns.sql[2]},target_best_page_id=${columns.sql[3]},manifest_id=? WHERE ${column}=(SELECT id FROM ${table} WHERE slug=?)`,
      ...columns.bindings,
      manifestId,
      slug
    ),
    statement('DELETE FROM taxonomy_redirects WHERE source_kind=? AND source_slug=?', kind, slug),
    insertRedirect(kind, slug, target, manifestId, now)
  ]
}
/** Refuses the batch unless the named tag and category of a best page's pool are active. */
function poolGuards(
  page: { category: string | null; tag: string | null },
  label: string
): PlannedStatement[] {
  return [
    ...(page.tag === null ? [] : targetActiveGuard({ kind: 'tag', slug: page.tag }, label, 'the')),
    ...(page.category === null
      ? []
      : targetActiveGuard({ kind: 'category', slug: page.category }, label, 'the'))
  ]
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
  if (mode === 'create')
    out.push(
      statement(
        "INSERT INTO listings (id,slug,name,description,website,content,entity_type,priority,is_unofficial,is_featured,is_active,status,published_at,display_order,source_kind,source_identity,source_updated_at,checksum,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,1,'draft',?,(SELECT COALESCE(MAX(display_order),-1)+1 FROM listings),'yaml-manifest-v1',?,?,?,?,?)",
        value.id,
        value.slug,
        value.name,
        value.description,
        value.website,
        value.content ?? null,
        value.entityType ?? null,
        value.priority ?? null,
        value.isUnofficial,
        value.featured,
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
        value.isUnofficial,
        value.featured,
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
        order === 0,
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
export const parseManifest = (source: string): PublicationManifest =>
  manifestSchema.parse(parse(source))

/**
 * A listing's logo and image rows as one JSON array of `[kind, url, media_key]`, ordered by kind
 * then sort order: what a `listing-media-update` compares and swaps on (`?` is the listing id).
 */
export const CURRENT_MEDIA_JSON = `(SELECT json_group_array(json_array(kind,url,media_key)) FROM (SELECT kind,url,media_key FROM listing_media WHERE listing_id=? AND kind IN ('logo','image') ORDER BY kind,sort_order))`

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
 * `routes`. Every guard runs before the write it protects, so a refusal writes nothing, and every
 * value is bound: the SQL text holds only the guards' reasons. Tags and listing tags are written
 * with `UPDATE`, or `INSERT … SELECT … WHERE is_active=1`, never an upsert: SQLite fires a
 * `BEFORE INSERT` trigger on an upsert's attempted insert even when it becomes an update, so an
 * upsert touching a retired tag would be refused (`0013_taxonomy_triggers.sql`).
 */
function taxonomyStatements(
  op: TaxonomyOperation,
  manifest: PublicationManifest,
  now: string,
  routes: Set<string>
): PlannedStatement[] {
  switch (op.action) {
    case 'tag-create': {
      const label = `tag-create ${op.tag.slug}`
      routes.add(tagRoute(op.tag.slug)).add(tagIndexRoute()).add(categoryRoute(op.tag.category))
      return [
        guard(
          'NOT EXISTS (SELECT 1 FROM tags WHERE slug=?)',
          `${label}: a tag has this slug, active or retired`,
          op.tag.slug
        ),
        statement(
          'INSERT INTO tags (slug,name,description,category_id,sort_order,is_active,created_at,updated_at) SELECT ?,?,?,id,?,1,?,? FROM categories WHERE slug=? AND is_active=1',
          op.tag.slug,
          op.tag.name,
          op.tag.description,
          op.tag.order,
          now,
          now,
          op.tag.category
        ),
        changedOne(`${label}: the category ${op.tag.category} is missing or retired`)
      ]
    }
    case 'tag-update': {
      const label = `tag-update ${op.slug}`
      routes
        .add(tagRoute(op.slug))
        .add(tagIndexRoute())
        .add(categoryRoute(op.expected.category))
        .add(categoryRoute(op.tag.category))
      return [
        guard(
          'EXISTS (SELECT 1 FROM tags t JOIN categories c ON c.id=t.category_id WHERE t.slug=? AND t.name=? AND t.description=? AND c.slug=?)',
          `${label}: the tag is missing or not as expected`,
          op.slug,
          op.expected.name,
          op.expected.description,
          op.expected.category
        ),
        ...targetActiveGuard({ kind: 'category', slug: op.tag.category }, label, 'the'),
        // A retired tag stays retired: `is_active` is not written.
        statement(
          'UPDATE tags SET name=?,description=?,category_id=(SELECT id FROM categories WHERE slug=?),sort_order=?,updated_at=? WHERE slug=?',
          op.tag.name,
          op.tag.description,
          op.tag.category,
          op.tag.order,
          now,
          op.slug
        )
      ]
    }
    case 'tag-unpublish': {
      const label = `tag-unpublish ${op.slug}`
      routes.add(tagRoute(op.slug)).add(tagIndexRoute()).add(targetRoute(op.redirect))
      return [
        guard(
          'NOT EXISTS (SELECT 1 FROM best_pages b JOIN tags t ON t.id=b.tag_id WHERE t.slug=? AND b.is_active=1)',
          `${label}: an active best page uses the tag`,
          op.slug
        ),
        ...retireWithRedirect('tag', op.slug, op.redirect, label, manifest.id, now)
      ]
    }
    case 'listing-tags-set': {
      const label = `listing-tags-set ${op.slug}`
      routes.add(listingRoute(op.slug)).add(tagIndexRoute())
      for (const tag of [...op.expected, ...op.tags]) routes.add(tagRoute(tag))
      return [
        // Approved, live or unpublished: the migration re-files unpublished listings too (1.5).
        guard(
          "EXISTS (SELECT 1 FROM listings WHERE id=? AND slug=? AND status='approved')",
          `${label}: no approved listing has this id and slug`,
          op.id,
          op.slug
        ),
        guard(
          `${CURRENT_TAGS_JSON}=?`,
          `${label}: its tags are not the expected ones`,
          op.id,
          JSON.stringify(op.expected)
        ),
        statement('DELETE FROM listing_tags WHERE listing_id=?', op.id),
        // A missing or retired tag inserts nothing: refused.
        ...op.tags.flatMap((tag, order) => [
          statement(
            'INSERT INTO listing_tags (listing_id,tag_id,sort_order) SELECT ?,id,? FROM tags WHERE slug=? AND is_active=1',
            op.id,
            order,
            tag
          ),
          changedOne(`${label}: the tag ${tag} is missing or retired`)
        ]),
        // The page shows its tags: sitemap lastmod (#218). The checksum stays, so a revision or a
        // paid submission read before this still applies (design 4.1).
        statement('UPDATE listings SET updated_at=? WHERE id=?', now, op.id),
        statement(
          "INSERT INTO listing_events (listing_id,event_type,detail,actor) VALUES (?,'edited',?,?)",
          op.id,
          JSON.stringify({
            fields: ['tags'],
            manifest: manifest.id,
            from: op.expected,
            to: op.tags
          }),
          manifest.provenance.actor
        )
      ]
    }
    case 'best-page-create': {
      const { page } = op
      const label = `best-page-create ${page.slug}`
      routes.add(bestRoute(page.slug)).add(bestIndexRoute())
      for (const route of poolRoutes(page)) routes.add(route)
      return [
        guard(
          'NOT EXISTS (SELECT 1 FROM best_pages WHERE slug=?)',
          `${label}: a best page has this slug, active or retired`,
          page.slug
        ),
        ...poolGuards(page, label),
        statement(
          `INSERT INTO best_pages (slug,${Object.keys(BEST_PAGE_WRITES).join(',')},is_active,created_at,updated_at) VALUES (?,${Object.values(BEST_PAGE_WRITES).join(',')},1,?,?)`,
          page.slug,
          ...bestPageColumns(page),
          now,
          now
        )
      ]
    }
    case 'best-page-update': {
      const { expected, page } = op
      const label = `best-page-update ${op.slug}`
      routes.add(bestRoute(op.slug)).add(bestIndexRoute())
      for (const route of [...poolRoutes(expected), ...poolRoutes(page)]) routes.add(route)
      return [
        // `IS`: the tag, category, volume, and check date may each be null.
        guard(
          'EXISTS (SELECT 1 FROM best_pages b LEFT JOIN tags t ON t.id=b.tag_id LEFT JOIN categories c ON c.id=b.category_id WHERE b.slug=? AND b.keyword=? AND b.title=? AND b.heading=? AND b.intro=? AND t.slug IS ? AND c.slug IS ? AND b.list_size=? AND b.keyword_volume IS ? AND b.keyword_checked_at IS ? AND b.sort_order=?)',
          `${label}: the best page is missing or not as expected`,
          op.slug,
          ...bestPageColumns(expected)
        ),
        ...poolGuards(page, label),
        statement(
          `UPDATE best_pages SET ${Object.entries(BEST_PAGE_WRITES)
            .map(([column, value]) => `${column}=${value}`)
            .join(',')},updated_at=? WHERE slug=?`,
          ...bestPageColumns(page),
          now,
          op.slug
        )
      ]
    }
    case 'best-page-listings-set': {
      const label = `best-page-listings-set ${op.slug}`
      routes.add(bestRoute(op.slug)).add(bestIndexRoute())
      const insert = (
        entry: { id: string; slug: string },
        values: string,
        ...bindings: unknown[]
      ) => [
        statement(
          `INSERT INTO best_page_listings (best_page_id,listing_id,position,excluded,blurb) SELECT (SELECT id FROM best_pages WHERE slug=?),id,${values} FROM listings WHERE id=? AND slug=? AND status='approved'`,
          op.slug,
          ...bindings,
          entry.id,
          entry.slug
        ),
        changedOne(`${label}: no approved listing is ${entry.slug} (${entry.id})`)
      ]
      return [
        // The page changed: its sitemap lastmod. Also the check that the page exists.
        statement('UPDATE best_pages SET updated_at=? WHERE slug=?', now, op.slug),
        changedOne(`${label}: no best page has this slug`),
        guard(
          `${CURRENT_PINS_JSON}=? AND ${CURRENT_EXCLUSIONS_JSON}=?`,
          `${label}: its pins and exclusions are not the expected ones`,
          op.slug,
          pinsJson(op.expected.pins),
          op.slug,
          exclusionsJson(op.expected.exclude)
        ),
        statement(
          'DELETE FROM best_page_listings WHERE best_page_id=(SELECT id FROM best_pages WHERE slug=?)',
          op.slug
        ),
        // `excluded` is the literal 0 or 1, never a bound boolean (#339 review).
        ...op.pins.flatMap((pin, index) => insert(pin, '?,0,?', index + 1, pin.blurb ?? null)),
        ...op.exclude.flatMap(entry => insert(entry, 'NULL,1,NULL'))
      ]
    }
    case 'best-page-unpublish': {
      const label = `best-page-unpublish ${op.slug}`
      routes.add(bestRoute(op.slug)).add(bestIndexRoute()).add(targetRoute(op.redirect))
      return retireWithRedirect('best', op.slug, op.redirect, label, manifest.id, now)
    }
    case 'taxonomy-redirect-set': {
      const { expected, from, to } = op
      const label = `taxonomy-redirect-set ${from.kind} ${from.slug}`
      routes.add(targetRoute(from)).add(targetRoute(to))
      const columns = targetColumns(to)
      return [
        guard(
          `${CURRENT_REDIRECT_TARGET} IS ?`,
          `${label}: its current target is not the expected one`,
          from.kind,
          from.slug,
          expected === null ? null : JSON.stringify(targetPair(expected))
        ),
        ...targetActiveGuard(to, label),
        expected === null
          ? insertRedirect(from.kind, from.slug, to, manifest.id, now)
          : statement(
              `UPDATE taxonomy_redirects SET target_kind=${columns.sql[0]},target_category_id=${columns.sql[1]},target_tag_id=${columns.sql[2]},target_best_page_id=${columns.sql[3]},manifest_id=? WHERE source_kind=? AND source_slug=?`,
              ...columns.bindings,
              manifest.id,
              from.kind,
              from.slug
            )
      ]
    }
  }
}
/**
 * Checks after a batch's last operation (#344, the ordering gap #338's review found): a later
 * operation in the same batch can retire what an earlier one pointed at. `category-unpublish`
 * re-points nothing, so retiring a category after a redirect to it, or after a best page drawing
 * on it, would leave a redirect to a retired page or an active best page on a retired hub.
 * Either refuses the whole batch, whatever the order of its operations.
 */
function taxonomyBatchChecks(manifest: PublicationManifest): PlannedStatement[] {
  return manifest.operations.flatMap(op => {
    const redirect =
      op.action === 'taxonomy-redirect-set'
        ? {
            kind: op.from.kind,
            label: `${op.action} ${op.from.kind} ${op.from.slug}`,
            slug: op.from.slug
          }
        : op.action === 'tag-unpublish'
          ? { kind: 'tag', label: `${op.action} ${op.slug}`, slug: op.slug }
          : op.action === 'best-page-unpublish'
            ? { kind: 'best', label: `${op.action} ${op.slug}`, slug: op.slug }
            : null
    if (redirect)
      return [
        guard(
          "EXISTS (SELECT 1 FROM taxonomy_redirects r LEFT JOIN categories c ON c.id=r.target_category_id LEFT JOIN tags t ON t.id=r.target_tag_id LEFT JOIN best_pages b ON b.id=r.target_best_page_id WHERE r.source_kind=? AND r.source_slug=? AND (r.target_kind='directory' OR c.is_active=1 OR t.is_active=1 OR b.is_active=1))",
          `${redirect.label}: by the end of the batch, its redirect is gone or its target is retired`,
          redirect.kind,
          redirect.slug
        )
      ]
    if (op.action === 'best-page-create' || op.action === 'best-page-update') {
      const slug = op.action === 'best-page-create' ? op.page.slug : op.slug
      return [
        guard(
          'EXISTS (SELECT 1 FROM best_pages b LEFT JOIN tags t ON t.id=b.tag_id LEFT JOIN categories c ON c.id=b.category_id WHERE b.slug=? AND (b.is_active=0 OR ((b.tag_id IS NULL OR t.is_active=1) AND (b.category_id IS NULL OR c.is_active=1))))',
          `${op.action} ${slug}: by the end of the batch, its tag or category is retired`,
          slug
        )
      ]
    }
    return []
  })
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
      statements.push(
        statement(
          'INSERT INTO categories (slug,name,description,sort_order,is_active) VALUES (?,?,?,?,1)',
          op.category.slug,
          op.category.name,
          op.category.description,
          op.category.order
        )
      )
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
      statements.push(
        statement(
          "UPDATE categories SET is_active=0,updated_at=? WHERE slug=? AND NOT EXISTS (SELECT 1 FROM listing_categories lc JOIN listings l ON l.id=lc.listing_id WHERE lc.category_id=categories.id AND l.status='approved' AND l.is_active=1)",
          now,
          op.slug
        ),
        statement(CHANGED_ONE_GUARD)
      )
      addCategories([op.slug])
    }
    if (op.action === 'listing-create' || op.action === 'listing-update') {
      if (op.action === 'listing-update') {
        statements.push(membershipGuard(op.listing.id, op.previousCategories))
        addCategories(op.previousCategories)
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
    if (op.action === 'listing-media-update') {
      const expected = expectedMediaJson(op.expected)
      statements.push(
        statement(
          `SELECT CASE WHEN EXISTS (SELECT 1 FROM listings WHERE id=? AND slug=?) AND ${CURRENT_MEDIA_JSON}=? THEN 1 ELSE ${GUARD_FAILURE} END`,
          op.id,
          op.slug,
          op.id,
          expected
        ),
        statement(
          "DELETE FROM listing_media WHERE listing_id=? AND kind IN ('logo','image')",
          op.id
        ),
        statement(
          "DELETE FROM media_ingestions WHERE listing_id=? AND kind IN ('logo','image')",
          op.id
        ),
        ...[
          ...(op.media.logo ? [['logo', op.media.logo, 0] as const] : []),
          ...(op.media.images ?? []).map((image, order) => ['image', image, order] as const)
        ].map(([kind, image, order]) =>
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
    ...taxonomyBatchChecks(manifest),
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

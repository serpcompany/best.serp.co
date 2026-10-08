import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { IMAGE_CONTENT_TYPES, MAX_IMAGE_SIDE } from '../apps/web/src/db/media-format'
import {
  contentTypeForKey,
  MAX_MEDIA_BYTES,
  MEDIA_HASH_LENGTH,
  parseMediaKey
} from '../apps/web/src/db/media-keys'
import { listingHasQueuedSubmission } from '../apps/web/src/db/plan-support'
import { parse } from 'yaml'
import { z } from 'zod'
import { hasFileExtension } from '../apps/web/src/lib/seo/canonical-url'
import { assertD1Compatible } from './d1-compat'
import { validateCanonicalLocalConfig } from './d1-local-config'
import { catalogSitemapRoutes, categoryRoute, listingIndexRoute, listingRoute } from './site-routes'

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
   * row-level (`rows`) manifest requires it.
   */
  z
    .object({
      action: z.literal('listing-unpublish'),
      id: listingId,
      slug: existingSlug,
      categories,
      reason: z.string().trim().min(1).max(200).optional(),
      expected: z.object({ website: z.string().url() }).strict().optional()
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
  z.object({ action: z.literal('category-unpublish'), slug: categorySlug }).strict()
])
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
 * media rows (`expected`), categories (`expected`), a description's length and ending (#105), and
 * an unpublish with its `expected.website` (#100: categories, live, website, no submission in
 * review).
 */
const rowLevelActions = new Set<string>([
  'listing-media-update',
  'listing-categories-add',
  'listing-content-remove-suffix',
  'listing-unpublish',
  'listing-claim-hold-add',
  'listing-claim-hold-clear'
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
              'A row-level manifest holds only listing-media-update, listing-categories-add, listing-content-remove-suffix, listing-unpublish, and listing-claim-hold-add/-clear operations.',
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
    value.operations.forEach((op, index) => {
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
  batch<T = unknown>(statements: BatchStatement[]): Promise<T[]>
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
  value.categories.forEach((cat, order) =>
    out.push(
      statement(
        'INSERT INTO listing_categories (listing_id,category_id,sort_order,is_primary) SELECT ?,id,?,? FROM categories WHERE slug=? AND is_active=1',
        value.id,
        order,
        order === 0,
        cat
      )
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
  value.media?.images?.forEach((image, order) => out.push(hostedRow('image', image, order)))
  if (value.media?.video)
    out.push(
      statement(
        "INSERT INTO listing_media (listing_id,kind,url,sort_order) VALUES (?,'video',?,0)",
        value.id,
        value.media.video
      )
    )
  value.resources?.forEach((item, order) =>
    out.push(
      statement(
        'INSERT INTO listing_resource_links (listing_id,label,url,sort_order) VALUES (?,?,?,?)',
        value.id,
        item.label,
        item.url,
        order
      )
    )
  )
  value.faqs?.forEach((item, order) =>
    out.push(
      statement(
        'INSERT INTO listing_faqs (listing_id,question,answer,sort_order) VALUES (?,?,?,?)',
        value.id,
        item.question,
        item.answer,
        order
      )
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
    if (!live || !live.checksum || !Number.isSafeInteger(live.version) || live.version < 0) {
      throw new Error('A row-level manifest is planned against the live publication state.')
    }
    return live
  }
  return {
    checksum: manifest.provenance.beforeChecksum ?? '',
    version: manifest.basePublicationVersion ?? -1
  }
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
  const addCategories = (values: string[]) =>
    values.forEach(value => routes.add(categoryRoute(value)))
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
    if (op.action === 'listing-categories-add') {
      statements.push(
        statement(
          `SELECT CASE WHEN EXISTS (SELECT 1 FROM listings WHERE id=? AND slug=?) AND (SELECT json_group_array(slug) FROM (SELECT c.slug FROM listing_categories lc JOIN categories c ON c.id=lc.category_id WHERE lc.listing_id=? ORDER BY lc.sort_order, c.slug))=? THEN 1 ELSE ${GUARD_FAILURE} END`,
          op.id,
          op.slug,
          op.id,
          JSON.stringify(op.expected)
        ),
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
      ...catalogSitemapRoutes(),
      '/rss.xml'
    ])
  ]
    .sort()
    .join('\n')
  statements.push(
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

import { z } from 'zod'
import { MAX_LISTING_TAGS } from '@/db/listing-plans'
import { BEST_PAGE_LIST_SIZE, MAX_SUGGESTED_TAGS } from '@/db/schema'

/**
 * Request bodies of the admin API (`/api/admin/*`, serpcompany/best.serp.co#64). Route handlers
 * parse every body with these before any read or write; the admin screens send the same shapes.
 */

const text = (max: number) => z.string().max(max)
const linkRel = z.enum(['follow', 'nofollow', 'sponsored'])
const tagSlug = z.string().trim().min(1).max(120)

/** Submission and revision ids: UUIDs today, opaque ids from the native flows (#63, #65). */
export const decisionIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/u)

export const approveSubmissionSchema = z.object({
  edits: z
    .object({
      categorySlug: text(120).optional(),
      content: text(20_000).optional(),
      description: text(400).optional(),
      logoUrl: text(2_000).optional(),
      name: text(200).optional(),
      /** The Creator's suggested tags as the reviewer edited them (#341). */
      tagSlugs: z.array(tagSlug).max(MAX_SUGGESTED_TAGS).optional()
    })
    .strict()
    .optional(),
  expectedContentVersion: z.number().int().positive(),
  /**
   * The hosted featured image the review screen showed, or null for none: approval adopts only
   * that image, and is refused if the submission's image changed since (#96 round 2 B1).
   */
  expectedImageKey: text(300).nullable().default(null),
  /** The hosted logo the review screen showed (null for the tile), as for the image. */
  expectedLogoKey: text(300).nullable().default(null),
  linkRel: linkRel.optional()
})

export const requestChangesSchema = z.object({ note: text(2_000) })

export const rejectSubmissionSchema = z.object({
  category: z.enum(['prohibited', 'other']),
  reason: text(2_000)
})

export const approveRevisionSchema = z.object({
  expectedContentVersion: z.number().int().positive(),
  expectedLogoKey: text(300).nullable().default(null)
})

export const rejectRevisionSchema = z.object({ reason: text(2_000) })

/** The block key the admin confirmed; the target is the record in the path. */
export const allowResubmissionSchema = z.object({ urlKey: text(300).optional() })

export const listingDetailsSchema = z.object({
  details: z
    .object({
      categorySlug: text(120),
      description: text(400),
      logoUrl: text(2_000),
      name: text(200),
      website: text(2_000)
    })
    .strict(),
  expectedChecksum: text(200)
})

/** A listing's tags in order, and the tags the admin saw (#341): `LISTING_TAGS_JSON`'s order. */
export const listingTagsSchema = z.object({
  expectedTags: z.array(tagSlug).max(200),
  tags: z.array(tagSlug).max(MAX_LISTING_TAGS)
})

export const unpublishListingSchema = z.object({ note: text(1_000).optional() })

export const linkRelSchema = z.object({ linkRel })

export const transferOwnerSchema = z.object({
  email: text(254),
  expectedOwnerUserId: z.string().max(200).nullable()
})

export const removeOwnerSchema = z.object({ expectedOwnerUserId: z.string().min(1).max(200) })

export const adminEmailSchema = z.object({ email: text(254) })

/**
 * The taxonomy screens (#405). A path's slug is checked against the stored rows, so it only has to
 * look like one; the decisions check every field (`lib/admin/taxonomy-fields.ts`).
 */
export const taxonomySlugSchema = z.string().regex(/^[a-z0-9-]{1,120}$/u)

const categoryFields = z
  .object({
    description: text(2_000),
    name: text(200),
    order: z.number().int().min(0).max(1_000_000),
    slug: text(120)
  })
  .strict()

export const createCategorySchema = categoryFields
export const updateCategorySchema = z.object({
  category: categoryFields,
  expected: categoryFields
})

const tagFields = z
  .object({ category: text(120), description: text(2_000), name: text(200), slug: text(120) })
  .strict()

export const createTagSchema = tagFields
export const updateTagSchema = z.object({ expected: tagFields, tag: tagFields })

const bestPageFields = z
  .object({
    intro: text(5_000),
    keyword: text(200),
    slug: text(120),
    tag: text(120),
    title: text(200)
  })
  .strict()

export const createBestPageSchema = bestPageFields
export const updateBestPageSchema = z.object({ expected: bestPageFields, page: bestPageFields })

const listingRef = z.object({ id: z.string().max(80), slug: z.string().max(300) }).strict()

/** A best page's pins in order, and the pins the admin saw. */
export const bestPagePinsSchema = z.object({
  expectedPins: z.array(listingRef).max(BEST_PAGE_LIST_SIZE.max),
  pins: z.array(listingRef).max(BEST_PAGE_LIST_SIZE.max)
})

/** Where a retired category, tag, or best page sends its URL: an active page, or `/products/`. */
export const retireTaxonomySchema = z.object({
  redirect: z.union([
    z.object({ kind: z.enum(['category', 'tag', 'best']), slug: taxonomySlugSchema }).strict(),
    z.object({ kind: z.literal('directory') }).strict()
  ])
})

export type ApproveSubmissionBody = z.infer<typeof approveSubmissionSchema>
export type ListingDetailsBody = z.infer<typeof listingDetailsSchema>

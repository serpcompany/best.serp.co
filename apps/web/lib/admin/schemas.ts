import { z } from 'zod'

/**
 * Request bodies of the admin API (`/api/admin/*`, serpcompany/best.serp.co#64). Route handlers
 * parse every body with these before any read or write; the admin screens send the same shapes.
 */

const text = (max: number) => z.string().max(max)
const linkRel = z.enum(['follow', 'nofollow', 'sponsored'])

/** Submission and revision ids: UUIDs today, opaque ids from the native flows (#63, #65). */
export const decisionIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/u)

export const approveSubmissionSchema = z.object({
  edits: z
    .object({
      categorySlug: text(120).optional(),
      content: text(20_000).optional(),
      description: text(400).optional(),
      logoUrl: text(2_000).optional(),
      name: text(200).optional()
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

export const unpublishListingSchema = z.object({ note: text(1_000).optional() })

export const linkRelSchema = z.object({ linkRel })

export const transferOwnerSchema = z.object({
  email: text(254),
  expectedOwnerUserId: z.string().max(200).nullable()
})

export const removeOwnerSchema = z.object({ expectedOwnerUserId: z.string().min(1).max(200) })

export const adminEmailSchema = z.object({ email: text(254) })

export type ApproveSubmissionBody = z.infer<typeof approveSubmissionSchema>
export type ListingDetailsBody = z.infer<typeof listingDetailsSchema>

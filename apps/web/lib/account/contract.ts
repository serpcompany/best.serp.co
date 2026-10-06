import { z } from 'zod'
import { draftContentSchema, SUBMISSION_FIELD_LIMITS } from '../submissions/contract'

/**
 * The submitter dashboard's HTTP contract (serpcompany/best.serp.co#65), shared by the route
 * handlers under `/api/account/` and the browser. The server checks the same rules again in
 * `@serpdirectory/data-ops/account` (`ACCOUNT_LIMITS`, https links).
 */

export const ACCOUNT_EXTRAS_LIMITS = {
  faqAnswer: 1000,
  faqQuestion: 200,
  items: 5,
  linkLabel: 60,
  linkUrl: 2048
} as const

export const LINK_URL_MESSAGE = 'Enter a full URL starting with https://'

const version = z.number().int().min(1)

export const extrasSchema = z.object({
  faqs: z
    .array(
      z.object({
        answer: z.string().max(ACCOUNT_EXTRAS_LIMITS.faqAnswer),
        question: z.string().max(ACCOUNT_EXTRAS_LIMITS.faqQuestion)
      })
    )
    .max(ACCOUNT_EXTRAS_LIMITS.items),
  resourceLinks: z
    .array(
      z.object({
        label: z.string().max(ACCOUNT_EXTRAS_LIMITS.linkLabel),
        url: z.string().max(ACCOUNT_EXTRAS_LIMITS.linkUrl)
      })
    )
    .max(ACCOUNT_EXTRAS_LIMITS.items)
})

export type ExtrasInput = z.infer<typeof extrasSchema>

/**
 * `POST /api/account/submissions/<id>/resubmit`: the fixed details, then back to review. FAQs
 * and links may be fixed in the same pass (both, or neither to keep them).
 */
export const resubmitRequestSchema = draftContentSchema
  .extend({
    expectedContentVersion: version,
    faqs: extrasSchema.shape.faqs.optional(),
    resourceLinks: extrasSchema.shape.resourceLinks.optional()
  })
  // Half a set would replace one list and silently keep the other (#102 review round 2).
  .refine(body => (body.faqs === undefined) === (body.resourceLinks === undefined), {
    message: 'Send both FAQs and links, or neither.',
    path: ['faqs']
  })

/** `POST /api/account/submissions/<id>/extras`: FAQs and links while it waits for review. */
export const extrasRequestSchema = extrasSchema.extend({ expectedContentVersion: version })

/**
 * `POST /api/account/listings/<id>/revision`: the edits of a live listing (#70 screen 7). The
 * name and website never change here. The logo stays as stored unless it changes (an imported
 * listing may keep a site-relative one), so it is checked on the server.
 */
export const revisionRequestSchema = extrasSchema.extend({
  /** The open revision's version the form loaded, or null when it loaded the live listing. */
  expectedRevisionVersion: version.nullable(),
  categorySlug: z.string().trim().min(1, 'Choose a primary category.').max(100),
  content: z
    .string()
    .trim()
    .max(SUBMISSION_FIELD_LIMITS.content, 'Keep the long description to 5,000 characters or fewer.')
    .default(''),
  description: z
    .string()
    .trim()
    .min(1, 'Add a short description.')
    .max(
      SUBMISSION_FIELD_LIMITS.description,
      `Keep it to ${SUBMISSION_FIELD_LIMITS.description} characters or fewer.`
    ),
  logoUrl: z.string().trim().min(1, 'Add a logo.').max(2048)
})

export type RevisionRequest = z.input<typeof revisionRequestSchema>
export type ResubmitRequest = z.input<typeof resubmitRequestSchema>

/** A link's URL problem as the form shows it, or null. */
export function linkUrlProblem(value: string): string | null {
  try {
    const url = new URL(value.trim())
    return url.protocol === 'https:' && url.hostname.includes('.') ? null : LINK_URL_MESSAGE
  } catch {
    return LINK_URL_MESSAGE
  }
}

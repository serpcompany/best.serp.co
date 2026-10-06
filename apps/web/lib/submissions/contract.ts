import { z } from 'zod'

/**
 * The submit flow's HTTP contract (serpcompany/best.serp.co#63), shared by the route handlers
 * and the browser: request schemas, response shapes, and the submission summary the pages
 * render. No server-only imports, and no Public Suffix List: the slug and the duplicate key
 * are derived on the server only, by `urlKey()`.
 */

/** Field limits; `@serpdirectory/data-ops/submissions` enforces the same (`SUBMISSION_LIMITS`). */
export const SUBMISSION_FIELD_LIMITS = { content: 5000, description: 160, name: 120 } as const
export const VERIFICATION_ATTEMPT_LIMIT = 10
export const VERIFICATION_COOLDOWN_SECONDS = 30

export const FIELD_MESSAGES = {
  categorySlug: 'Choose a primary category.',
  description: 'Add a short description.',
  logoUrl: 'Add a logo. Use the one from your site or paste an image link.',
  name: 'Enter the product name.',
  website: 'Enter your website address, starting with https://.'
} as const

export type SubmissionField = keyof typeof FIELD_MESSAGES | 'content'

const httpUrl = (message: string) =>
  z
    .string()
    .trim()
    .max(2048, message)
    .refine(value => {
      try {
        const url = new URL(value)
        return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname.length > 0
      } catch {
        return false
      }
    }, message)

export function descriptionLengthMessage(length: number): string {
  return `Keep it to ${SUBMISSION_FIELD_LIMITS.description} characters or fewer. It’s ${length} now.`
}

export const draftContentSchema = z.object({
  categorySlug: z.string().trim().min(1, FIELD_MESSAGES.categorySlug).max(100),
  content: z
    .string()
    .trim()
    .max(SUBMISSION_FIELD_LIMITS.content, 'Keep the long description to 5,000 characters or fewer.')
    .default(''),
  description: z
    .string()
    .trim()
    .min(1, FIELD_MESSAGES.description)
    .superRefine((value, context) => {
      if (value.length > SUBMISSION_FIELD_LIMITS.description) {
        context.addIssue({ code: 'custom', message: descriptionLengthMessage(value.length) })
      }
    }),
  logoUrl: httpUrl(FIELD_MESSAGES.logoUrl),
  name: z
    .string()
    .trim()
    .min(1, FIELD_MESSAGES.name)
    .max(SUBMISSION_FIELD_LIMITS.name, 'Keep the name to 120 characters or fewer.')
})

export const newDraftSchema = draftContentSchema.extend({
  website: httpUrl(FIELD_MESSAGES.website)
})

export const draftUpdateSchema = draftContentSchema.extend({
  expectedContentVersion: z.number().int().min(1)
})

export const prefillRequestSchema = z.object({ url: z.string().trim().min(1).max(2048) })

export const planRequestSchema = z.object({ plan: z.literal('free') })

export type DraftContentInput = z.input<typeof draftContentSchema>
export type NewDraftRequest = z.input<typeof newDraftSchema>

/** Field errors from a schema result, first message per field. */
export function fieldErrors(error: z.ZodError): Partial<Record<SubmissionField, string>> {
  const errors: Partial<Record<SubmissionField, string>> = {}
  for (const issue of error.issues) {
    const field = issue.path[0]
    if (typeof field === 'string' && !(field in errors)) {
      errors[field as SubmissionField] = issue.message
    }
  }
  return errors
}

/** Adds `https://` to an address typed without a scheme (`quillmate.app`). */
export function normalizeWebsiteInput(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  return /^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`
}

/** Whether a website can be submitted; the server's `UrlAvailability`, plus listing paths. */
export type Availability =
  | { kind: 'available'; slug: string }
  | { kind: 'invalid'; message: string }
  | { kind: 'blocked'; slug: string }
  | {
      kind: 'listed'
      listing: {
        categoryName: string | null
        logoUrl: string | null
        name: string
        path: string
        public: boolean
        slug: string
      }
    }
  | {
      kind: 'pending'
      mine: { id: string; nextPath: string; status: SubmissionStatusName } | null
      slug: string
    }

export interface PrefillResponse {
  availability: Availability
  prefill:
    | {
        description: { source: string; value: string } | null
        host: string
        name: { source: string; value: string } | null
        ok: true
        siteIcon: string | null
        socialImage: string | null
      }
    | { code: string; host: string; ok: false }
    | null
  website: string
}

export type SubmissionStatusName =
  | 'approved'
  | 'changes_requested'
  | 'draft'
  | 'paid_pending_review'
  | 'pending_badge'
  | 'rejected'
  | 'verified'
  | 'withdrawn'

/** What the submit pages and the account table show of an owner's submission. */
export interface SubmissionSummary {
  badgeVerifiedAt: string | null
  categoryName: string | null
  categorySlug: string
  content: string
  contentVersion: number
  description: string
  /** Days until an unpicked draft expires (30 days after it was first saved); null otherwise. */
  draftExpiresInDays: number | null
  id: string
  lastVerificationAt: string | null
  lastVerificationError: string | null
  logoUrl: string
  name: string
  plan: 'free' | 'paid' | null
  slug: string
  status: SubmissionStatusName
  verificationAttempts: number
  website: string
}

export interface ApiError {
  availability?: Availability
  code: string
  error: string
  fields?: Partial<Record<SubmissionField, string>>
}

export const DRAFT_LIFETIME_DAYS = 30

/** The next page of the submit flow for a submission, or null when there is none. */
export function nextStepPath(submission: { id: string; status: SubmissionStatusName }): string {
  if (submission.status === 'draft') return `/submit/${submission.id}/choose/`
  if (submission.status === 'pending_badge' || submission.status === 'verified') {
    return `/submit/${submission.id}/badge/`
  }
  return '/account/'
}

export function listingPath(slug: string): string {
  return `/products/${slug}/`
}

export function hostOf(website: string): string {
  try {
    return new URL(website).hostname.replace(/^www\./u, '')
  } catch {
    return website
  }
}

/** Whole days left before a draft saved at `savedAt` expires, at least 0. */
export function draftExpiresInDays(savedAt: string | null, now: Date): number | null {
  if (!savedAt) return null
  const saved = Date.parse(savedAt)
  if (Number.isNaN(saved)) return null
  const left = saved + DRAFT_LIFETIME_DAYS * 86_400_000 - now.getTime()
  return Math.max(0, Math.ceil(left / 86_400_000))
}

/** `last_verification_at` (`YYYY-MM-DD HH:MM:SS`, UTC) as epoch milliseconds, or null. */
export function verificationInstant(value: string | null): number | null {
  if (!value) return null
  const parsed = Date.parse(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`)
  return Number.isNaN(parsed) ? null : parsed
}

/** `nofollow` is the code stored before `link_not_followed` (#84). */
const CONCLUSIVE_FAILURES = new Set([
  'badge_missing',
  'link_not_followed',
  'nofollow',
  'page_not_followed',
  'wrong_destination'
])

export function isConclusiveFailure(code: string | null): boolean {
  return code !== null && CONCLUSIVE_FAILURES.has(code)
}

/** Checks left before automatic checks pause (connection problems never use one up). */
export function checksLeft(submission: {
  lastVerificationError: string | null
  verificationAttempts: number
}): number {
  return Math.max(0, VERIFICATION_ATTEMPT_LIMIT - submission.verificationAttempts)
}

export const LOGO_HTTPS_MESSAGE = 'Use an image address that starts with https://.'

/**
 * Logos are hotlinked on https pages, so their URL must be https (PR #84 review round 1,
 * finding 6); a local Worker also accepts http for its fixture sites. Logos only ever render
 * through `<img referrerpolicy="no-referrer" loading="lazy">`, never inline, `<object>`, or
 * `<iframe>` (an SVG may hold a script). #64: re-check the logo URL (`checkLogoUrl`) when an
 * admin approves, since the image can change after it was saved.
 */
export function logoUrlProblem(value: string, allowInsecure: boolean): string | null {
  try {
    const url = new URL(value.trim())
    if (url.username || url.password) return LOGO_HTTPS_MESSAGE
    if (url.protocol === 'https:') return null
    if (url.protocol === 'http:' && allowInsecure) return null
    return LOGO_HTTPS_MESSAGE
  } catch {
    return FIELD_MESSAGES.logoUrl
  }
}

/** Why a logo URL was refused (`checkLogoUrl` in `./prefill.ts`). */
export const LOGO_MESSAGES = {
  logo_not_image: 'That link isn’t a PNG, JPG, SVG or WebP image.',
  logo_too_large: 'That image is larger than 1 MB.',
  logo_too_small: 'That image is smaller than 128 × 128 px.',
  logo_unreachable:
    'We couldn’t load that image. Use a public image link, or the icon from your site.'
} as const

export function checksPaused(submission: {
  lastVerificationError: string | null
  verificationAttempts: number
}): boolean {
  return (
    submission.verificationAttempts >= VERIFICATION_ATTEMPT_LIMIT &&
    (submission.lastVerificationError === null ||
      isConclusiveFailure(submission.lastVerificationError))
  )
}

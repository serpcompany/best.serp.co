import 'server-only'

import type { z } from 'zod'
import { fieldErrors, LOGO_MESSAGES, logoUrlProblem } from '@/lib/submissions/contract'
import { apiError } from '@/lib/submissions/http'
import { checkLogoUrl } from '@/lib/submissions/prefill'
import { insecureLogosAllowed } from '@/lib/submissions/repository'

/**
 * Shared steps of the dashboard's write routes (`/api/account/*`, #65). Each route first calls
 * `authorizeUserRequest()` itself (the session, and a trusted `Origin` for every write: the
 * CSRF check #60 and #64 use; the architecture guard requires the call in every route file).
 * Answers are JSON and never cached (`lib/submissions/http.ts`).
 */

/** Ids the routes accept: submission UUIDs and listing ids. Anything else is a 404. */
export const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,100}$/u

export function accountNotFound(what: 'listing' | 'submission') {
  return apiError(404, 'not_found', `${what === 'listing' ? 'Listing' : 'Submission'} not found.`)
}

export function parseBody<S extends z.ZodTypeAny>(
  schema: S,
  value: unknown
): { data: z.infer<S>; ok: true } | { ok: false; response: Response } {
  const parsed = schema.safeParse(value ?? {})
  if (parsed.success) return { data: parsed.data, ok: true }
  return {
    ok: false,
    response: apiError(400, 'invalid_request', 'Check the highlighted fields.', {
      fields: fieldErrors(parsed.error)
    })
  }
}

/**
 * Checks a logo the owner changed, as the submit flow does (#63): https (http on a local
 * Worker only), then a fetch that confirms a PNG, JPEG, WebP, or SVG within the size rules.
 * Null when it may be saved.
 */
export async function changedLogoProblem(logoUrl: string): Promise<Response | null> {
  const httpsProblem = logoUrlProblem(logoUrl, await insecureLogosAllowed())
  if (httpsProblem) {
    return apiError(400, 'invalid_logo', httpsProblem, { fields: { logoUrl: httpsProblem } })
  }
  const logo = await checkLogoUrl(logoUrl)
  if (logo.ok) return null
  return apiError(400, logo.code, LOGO_MESSAGES[logo.code], {
    fields: { logoUrl: LOGO_MESSAGES[logo.code] }
  })
}

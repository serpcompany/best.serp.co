import 'server-only'

import type { z } from 'zod'
import type { AdminContext, Decision } from './decisions'
import { adminDecisionContext } from './runtime'

/**
 * The shared shape of every admin write (`/api/admin/*`, serpcompany/best.serp.co#64). The admin
 * panel uses route handlers, not Server Actions. Each route first calls
 * `authorizeAdminRequest()` itself (an admin session re-checked against the allowlist, and for
 * any write an `Origin` among this Worker's trusted origins: the CSRF check; the architecture
 * guard requires the call in every route file), then hands the admin's email here. This parses
 * the JSON body with its schema before anything touches D1, runs the decision, and answers JSON
 * that is never cached.
 */

const MAX_BODY_BYTES = 64 * 1024
const headers = { 'cache-control': 'private, no-store' }

export function adminJson(body: unknown, status: number): Response {
  return Response.json(body, { headers, status })
}

async function readJson(request: Request): Promise<unknown | Response> {
  const type = request.headers.get('content-type') ?? ''
  if (!/^application\/json\b/iu.test(type)) {
    return adminJson({ error: 'unsupported_media_type', message: 'Send JSON.' }, 415)
  }
  const raw = await request.text()
  if (raw.length > MAX_BODY_BYTES) {
    return adminJson({ error: 'payload_too_large', message: 'The request is too large.' }, 413)
  }
  try {
    return raw ? JSON.parse(raw) : {}
  } catch {
    return adminJson({ error: 'invalid_json', message: 'The request is not valid JSON.' }, 400)
  }
}

/** Parses the body, runs one decision for an already authorized admin, and answers it. */
export async function runAdminDecision<S extends z.ZodTypeAny, T extends object>(
  request: Request,
  actor: string,
  schema: S,
  decide: (context: AdminContext, body: z.infer<S>) => Promise<Decision<T>>
): Promise<Response> {
  const body = await readJson(request)
  if (body instanceof Response) return body
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    return adminJson({ error: 'invalid_request', message: 'The request is missing a field.' }, 422)
  }
  try {
    const decision = await decide(await adminDecisionContext(actor), parsed.data)
    return adminJson(decision, decision.ok ? 200 : decision.status)
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'admin_decision_failed',
        message: error instanceof Error ? error.message : String(error)
      })
    )
    return adminJson({ error: 'unavailable', message: 'Something went wrong. Try again.' }, 503)
  }
}

export const unknownAdminEndpoint = () =>
  adminJson({ error: 'not_found', message: 'No such admin endpoint.' }, 404)

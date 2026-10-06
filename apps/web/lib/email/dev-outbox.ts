import { type EmailEnvironmentVars, resolveEmailPolicy } from './config'
import { readDevEmailOutbox } from './senders'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/**
 * True only for a Worker whose `SITE_ENVIRONMENT` and `D1_RUNTIME_ENV` both say `local` (and
 * which therefore logs email instead of sending it). Either var alone is not enough.
 */
export function isLocalEmailWorker(env: EmailEnvironmentVars): boolean {
  try {
    const policy = resolveEmailPolicy(env)
    return policy.environment === 'local' && policy.delivery === 'log'
  } catch {
    return false
  }
}

/**
 * `GET /api/dev/email-outbox?to=<address>` (local only): the emails the local log sender
 * delivered to that address in the last 30 minutes, for end-to-end tests (#63). Any other
 * Worker answers 404: staging and production deliver through useSend and keep no outbox.
 */
export function devEmailOutboxResponse(env: EmailEnvironmentVars, requestUrl: string): Response {
  if (!isLocalEmailWorker(env)) {
    return Response.json({ error: 'not_found' }, { headers: NO_STORE, status: 404 })
  }
  const to = new URL(requestUrl).searchParams.get('to') ?? ''
  return Response.json(
    { messages: to ? readDevEmailOutbox(to) : [] },
    { headers: NO_STORE, status: 200 }
  )
}

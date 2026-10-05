import { getCloudflareContext } from '@opennextjs/cloudflare'
import { NextResponse } from 'next/server'
import { resolveEmailPolicy } from '@/lib/email/config'
import { readDevEmailOutbox } from '@/lib/email/senders'

export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/** True only for a Worker configured as local (`SITE_ENVIRONMENT` and `D1_RUNTIME_ENV`). */
async function isLocalWorker(): Promise<boolean> {
  try {
    const { env } = await getCloudflareContext({ async: true })
    const policy = resolveEmailPolicy(env as CloudflareEnv)
    return policy.environment === 'local' && policy.delivery === 'log'
  } catch {
    return false
  }
}

/**
 * `GET /api/dev/email-outbox?to=<address>` (local only): the emails the local log sender
 * delivered to that address in the last 30 minutes, for end-to-end tests (#63). Staging and
 * production answer 404, as they deliver through useSend and keep no outbox.
 */
export async function GET(request: Request): Promise<NextResponse> {
  if (!(await isLocalWorker())) {
    return NextResponse.json({ error: 'not_found' }, { headers: NO_STORE, status: 404 })
  }
  const to = new URL(request.url).searchParams.get('to') ?? ''
  return NextResponse.json(
    { messages: to ? readDevEmailOutbox(to) : [] },
    { headers: NO_STORE, status: 200 }
  )
}

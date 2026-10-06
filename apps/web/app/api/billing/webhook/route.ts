import { billing } from '@/lib/billing/runtime'
import { handleWebhook } from '@/lib/billing/service'

export const dynamic = 'force-dynamic'

/** Larger than any checkout event the provider sends; a bigger body is refused unread. */
const MAX_WEBHOOK_BYTES = 256 * 1024

function answer(body: Record<string, unknown>, status: number): Response {
  return Response.json(body, { headers: { 'cache-control': 'private, no-store' }, status })
}

/**
 * `POST /api/billing/webhook/` (#68): the billing provider's webhook (Stripe today). The raw
 * body is verified against the signature header and its timestamp before anything is read, and
 * each event id is processed once (`billing_events`). 404 while orders are off.
 */
export async function POST(request: Request): Promise<Response> {
  let deps: Awaited<ReturnType<typeof billing>>
  try {
    deps = await billing()
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'billing_unavailable',
        message: error instanceof Error ? error.message : String(error)
      })
    )
    return answer({ error: 'unavailable' }, 503)
  }
  if (!deps) return answer({ error: 'not_found' }, 404)
  if (Number(request.headers.get('content-length') ?? 0) > MAX_WEBHOOK_BYTES) {
    return answer({ error: 'payload_too_large' }, 413)
  }
  const body = await request.text()
  if (body.length > MAX_WEBHOOK_BYTES) return answer({ error: 'payload_too_large' }, 413)
  try {
    const result = await handleWebhook(deps, { body, headers: request.headers })
    return answer(result.body, result.status)
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'billing_webhook_failed',
        message: error instanceof Error ? error.message : String(error)
      })
    )
    // Unprocessed: the provider retries, and the retry runs the event again.
    return answer({ error: 'processing_failed' }, 500)
  }
}

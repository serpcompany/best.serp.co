import { getCloudflareContext } from '@opennextjs/cloudflare'
import { devEmailOutboxResponse } from '@/lib/email/dev-outbox'

export const dynamic = 'force-dynamic'

/** `GET /api/dev/email-outbox?to=<address>`: local only (`lib/email/dev-outbox.ts`). */
export async function GET(request: Request): Promise<Response> {
  let env: CloudflareEnv | null = null
  try {
    env = (await getCloudflareContext({ async: true })).env as CloudflareEnv
  } catch {
    env = null
  }
  return devEmailOutboxResponse(env ?? {}, request.url)
}

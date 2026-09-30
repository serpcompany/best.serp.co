import { getCloudflareContext } from '@opennextjs/cloudflare'
import { verifyReplatformPreviewCapability } from '@serpdirectory/data-ops/replatform-preview-capability'
import { submissionBadgeTargets } from '@/lib/submissions/presentation'

export async function GET(request: Request): Promise<Response> {
  const { env } = await getCloudflareContext({ async: true })
  const workerEnv = env as CloudflareEnv & {
    REPLATFORM_PREVIEW_RUN_ID?: string
    REPLATFORM_PREVIEW_SIGNING_SECRET?: string
  }
  const url = new URL(request.url)
  const token = url.searchParams.get('token') || ''
  const slug = url.searchParams.get('slug') || ''
  const authorized = await verifyReplatformPreviewCapability({
    now: Math.floor(Date.now() / 1000),
    runId: workerEnv.REPLATFORM_PREVIEW_RUN_ID || '',
    secret: workerEnv.REPLATFORM_PREVIEW_SIGNING_SECRET || '',
    slug,
    token
  })
  if (workerEnv.D1_RUNTIME_ENV !== 'preview' || !authorized)
    return new Response('Not found', { status: 404 })
  if (!slug || !/^[a-z0-9.-]+$/u.test(slug)) return new Response('Not found', { status: 404 })
  const targets = submissionBadgeTargets(slug)
  const html = `<a href="${targets.listingUrl}"><img src="${targets.badgeUrls[0]}" alt="Featured on serp.software"></a>`
  return new Response(html, {
    headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/html; charset=utf-8' }
  })
}

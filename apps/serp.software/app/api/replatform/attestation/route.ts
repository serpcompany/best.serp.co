import { getCloudflareContext } from '@opennextjs/cloudflare'
import { verifyReplatformPreviewCapability } from '@serpdirectory/data-ops/replatform-preview-capability'

interface ReplatformEnv extends CloudflareEnv {
  REPLATFORM_PREVIEW_COMMIT_SHA?: string
  REPLATFORM_PREVIEW_BINDING_NONCE?: string
  REPLATFORM_PREVIEW_RUN_ID?: string
  REPLATFORM_PREVIEW_SIGNING_SECRET?: string
  REPLATFORM_PREVIEW_WORKER_NAME?: string
}

export async function GET(request: Request): Promise<Response> {
  const { env } = await getCloudflareContext({ async: true })
  const workerEnv = env as ReplatformEnv
  const url = new URL(request.url)
  const authorized = await verifyReplatformPreviewCapability({
    now: Math.floor(Date.now() / 1000),
    runId: workerEnv.REPLATFORM_PREVIEW_RUN_ID || '',
    secret: workerEnv.REPLATFORM_PREVIEW_SIGNING_SECRET || '',
    slug: url.hostname,
    token: url.searchParams.get('token') || ''
  })
  if (workerEnv.D1_RUNTIME_ENV !== 'preview' || !authorized)
    return Response.json({ error: 'not_found' }, { status: 404 })
  const marker = await workerEnv.DB.prepare(
    'SELECT nonce FROM _replatform_preview_attestation WHERE id=1'
  ).first<{ nonce: string }>()
  if (!marker || marker.nonce !== workerEnv.REPLATFORM_PREVIEW_BINDING_NONCE)
    return Response.json({ error: 'not_found' }, { status: 404 })
  return Response.json(
    {
      bindingNonce: marker.nonce,
      commit: workerEnv.REPLATFORM_PREVIEW_COMMIT_SHA,
      environment: workerEnv.D1_RUNTIME_ENV,
      hostname: url.hostname,
      run: workerEnv.REPLATFORM_PREVIEW_RUN_ID,
      service: workerEnv.REPLATFORM_PREVIEW_WORKER_NAME,
      siteId: workerEnv.SITE_ID
    },
    { headers: { 'Cache-Control': 'no-store' } }
  )
}

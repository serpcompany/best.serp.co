/**
 * Listing media from Worker bindings (serpcompany/best.serp.co#95), for code outside Next.js:
 * the cron in `worker.ts` and the local `/_media` route. Route handlers reach the same
 * operations through `./server.ts`.
 *
 * Fails closed: an unknown environment or a missing `DB` or `MEDIA` binding refuses to ingest.
 */

import {
  isMediaKey,
  LOCAL_MEDIA_PATH,
  MEDIA_CACHE_CONTROL
} from '@serpdirectory/data-ops/media-keys'
import {
  createMediaOperations,
  type MediaOperations,
  type MediaRunSummary
} from '@serpdirectory/data-ops/media-operations'

export interface MediaWorkerEnv {
  D1_RUNTIME_ENV?: string
  DB?: D1Database
  MEDIA?: R2Bucket
  SITE_ENVIRONMENT?: string
}

const runtimeEnvironments = new Set(['local', 'staging', 'production'])

function log(event: Record<string, unknown>): void {
  console.info(JSON.stringify(event))
}

export function createWorkerMediaOperations(env: MediaWorkerEnv): MediaOperations {
  if (!runtimeEnvironments.has(env.D1_RUNTIME_ENV ?? '')) {
    throw new Error('A valid D1_RUNTIME_ENV is required for listing media.')
  }
  if (!env.DB) throw new Error('D1 binding DB is required for listing media.')
  if (!env.MEDIA) throw new Error('R2 binding MEDIA is required for listing media.')
  return createMediaOperations({ bucket: env.MEDIA, db: env.DB, observe: log })
}

/** The cron (`triggers.crons` in wrangler.jsonc): retry the media slots that are due. */
export async function runMediaCron(env: MediaWorkerEnv): Promise<MediaRunSummary | null> {
  let operations: MediaOperations
  try {
    operations = createWorkerMediaOperations(env)
  } catch (error) {
    log({ event: 'media_cron_disabled', message: error instanceof Error ? error.message : '' })
    return null
  }
  return operations.processDueMedia()
}

/**
 * Locally the bucket has no public host, so the Worker serves it at `/_media/<key>`
 * (`MEDIA_BASE_URL` is `/_media`). Staging and production never answer here: their pages use
 * the bucket's custom domain. Returns null when the request is not a local media read.
 */
export async function serveLocalMedia(
  request: Request,
  env: MediaWorkerEnv
): Promise<Response | null> {
  if (env.SITE_ENVIRONMENT !== 'local' || env.D1_RUNTIME_ENV !== 'local') return null
  const url = new URL(request.url)
  if (!url.pathname.startsWith(`${LOCAL_MEDIA_PATH}/`)) return null
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { headers: { Allow: 'GET, HEAD' }, status: 405 })
  }
  const key = decodeURIComponent(url.pathname.slice(LOCAL_MEDIA_PATH.length + 1))
  const object = isMediaKey(key) && env.MEDIA ? await env.MEDIA.get(key) : null
  if (!object) return new Response('Not found', { status: 404 })
  return new Response(request.method === 'HEAD' ? null : object.body, {
    headers: {
      'Cache-Control': object.httpMetadata?.cacheControl ?? MEDIA_CACHE_CONTROL,
      'Content-Length': String(object.size),
      'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream',
      ETag: object.httpEtag,
      'X-Content-Type-Options': 'nosniff'
    }
  })
}

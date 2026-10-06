import 'server-only'

import { getCloudflareContext } from '@opennextjs/cloudflare'
import type { MediaOperations } from '@serpdirectory/data-ops/media-operations'
import { validatePublicHttpUrl } from '@serpdirectory/data-ops/public-url'
import { readSitePrefill } from '../submissions/prefill'
import { createWorkerMediaOperations } from './worker-media'

/**
 * Listing media for route handlers (serpcompany/best.serp.co#95). Submit v2 (#84) hosts a
 * saved submission's logo and social image under `best.serp.co/submissions/<id>/` through
 * `hostSubmissionImages`; approval later copies them into the listing's path. The admin
 * listing editor hosts a changed logo through `createMediaHost` (`worker-media.ts`).
 */
export async function mediaOperations(): Promise<MediaOperations> {
  const { env } = await getCloudflareContext({ async: true })
  return createWorkerMediaOperations(env as CloudflareEnv)
}

function log(event: Record<string, unknown>): void {
  console.info(JSON.stringify(event))
}

/** A source worth trying: a public https URL (http too on a local Worker, for its fixtures). */
function hostableSource(value: string | null | undefined, local: boolean): string | null {
  if (!value) return null
  const checked = validatePublicHttpUrl(value.trim())
  if (!checked.ok) return null
  if (checked.url.protocol !== 'https:' && !local) return null
  return checked.url.toString()
}

/**
 * Copies a saved submission's logo and featured image into the media bucket after the response
 * (`waitUntil`), under the submission's own prefix. The featured image is the social image the
 * server's own prefill finds on the submitted website, never a URL the client sends (#96 review
 * round 2, B1); the reviewer sees it before approval adopts it. Never fails the save: a slot
 * that cannot be hosted now is recorded and retried by the media cron (or fails with its
 * reason, which the reviewer sees). Without a `MEDIA` binding it logs and does nothing.
 */
export async function hostSubmissionImages(input: {
  logoUrl?: string | null
  submissionId: string
  /** The submission's website: when given, its prefill's social image becomes the image. */
  website?: string
}): Promise<void> {
  const { ctx, env } = await getCloudflareContext({ async: true })
  const workerEnv = env as CloudflareEnv
  const local = workerEnv.D1_RUNTIME_ENV === 'local' && workerEnv.SITE_ENVIRONMENT === 'local'
  let operations: MediaOperations
  try {
    operations = createWorkerMediaOperations(workerEnv)
  } catch (error) {
    log({
      event: 'submission_media_disabled',
      message: error instanceof Error ? error.message : String(error)
    })
    return
  }
  const host = async (kind: 'image' | 'logo', source: string | null | undefined) => {
    const sourceUrl = hostableSource(source, local)
    if (!sourceUrl) return
    await operations.hostSubmissionMedia({
      kind,
      sortOrder: 0,
      sourceUrl,
      submissionId: input.submissionId
    })
  }
  const failed = (kind: string) => (error: unknown) =>
    log({
      event: 'submission_media_error',
      kind,
      message: error instanceof Error ? error.message : String(error)
    })
  ctx.waitUntil(host('logo', input.logoUrl).catch(failed('logo')))
  const { website } = input
  if (website) {
    ctx.waitUntil(
      readSitePrefill(website, fetch, { allowInsecureLogos: local })
        .then(prefill => (prefill.ok ? host('image', prefill.socialImage) : undefined))
        .catch(failed('image'))
    )
  }
}

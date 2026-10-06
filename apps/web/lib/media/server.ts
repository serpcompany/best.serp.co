import 'server-only'

import { getCloudflareContext } from '@opennextjs/cloudflare'
import type { MediaOperations } from '@serpdirectory/data-ops/media-operations'
import { validatePublicHttpUrl } from '@serpdirectory/data-ops/public-url'
import { readSitePrefill } from '../submissions/prefill'
import { createWorkerMediaOperations } from './worker-media'

/**
 * Listing media for route handlers (serpcompany/best.serp.co#95). Submit v2 (#84) hosts a
 * saved submission's logo and social image under `best.serp.co/submissions/<id>/` through
 * `hostSubmissionImages`, and a listing revision's save hosts its logo under
 * `best.serp.co/revisions/<id>/` through `hostRevisionLogo`; approval later copies the reviewed
 * key into the listing's path. The admin listing editor hosts a changed logo through
 * `createMediaHost` (`worker-media.ts`).
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

async function backgroundMedia(event: string): Promise<{
  local: boolean
  operations: MediaOperations
  waitUntil: (promise: Promise<unknown>) => void
} | null> {
  const { ctx, env } = await getCloudflareContext({ async: true })
  const workerEnv = env as CloudflareEnv
  const local = workerEnv.D1_RUNTIME_ENV === 'local' && workerEnv.SITE_ENVIRONMENT === 'local'
  try {
    return {
      local,
      operations: createWorkerMediaOperations(workerEnv),
      waitUntil: promise => ctx.waitUntil(promise)
    }
  } catch (error) {
    log({ event, message: error instanceof Error ? error.message : String(error) })
    return null
  }
}

function logFailure(event: string, kind: string) {
  return (error: unknown) =>
    log({ event, kind, message: error instanceof Error ? error.message : String(error) })
}

/**
 * Copies a saved listing revision's logo into the media bucket after the response (#96 review
 * round 4, S1), under the revision's own prefix (`best.serp.co/revisions/<id>/…`), so the
 * reviewer sees the hosted copy and approval adopts exactly that key; a revision that keeps the
 * listing's hosted logo needs no copy. #102's revision-save route calls this after its batch,
 * with the revision's saved `logo_url`. Never fails the save: a logo that cannot be hosted now
 * is retried by the media cron (or fails), and approval then keeps the listing's current logo.
 * Without a `MEDIA` binding it logs and does nothing.
 */
export async function hostRevisionLogo(input: {
  logoUrl: string | null | undefined
  revisionId: string
}): Promise<void> {
  const media = await backgroundMedia('revision_media_disabled')
  if (!media) return
  const sourceUrl = hostableSource(input.logoUrl, media.local)
  if (!sourceUrl) return
  media.waitUntil(
    media.operations
      .hostRevisionMedia({ kind: 'logo', revisionId: input.revisionId, sortOrder: 0, sourceUrl })
      .catch(logFailure('revision_media_error', 'logo'))
  )
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
  const media = await backgroundMedia('submission_media_disabled')
  if (!media) return
  const { local, operations } = media
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
  const failed = (kind: string) => logFailure('submission_media_error', kind)
  media.waitUntil(host('logo', input.logoUrl).catch(failed('logo')))
  const { website } = input
  if (website) {
    media.waitUntil(
      readSitePrefill(website, fetch, { allowInsecureLogos: local })
        .then(prefill => (prefill.ok ? host('image', prefill.socialImage) : undefined))
        .catch(failed('image'))
    )
  }
}

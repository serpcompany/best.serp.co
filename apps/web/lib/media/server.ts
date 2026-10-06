import 'server-only'

import { getCloudflareContext } from '@opennextjs/cloudflare'
import type { MediaOperations } from '@serpdirectory/data-ops/media-operations'
import { createWorkerMediaOperations } from './worker-media'

/**
 * Listing media for route handlers (serpcompany/best.serp.co#95). Submit v2 (#84) calls
 * `hostSubmissionMedia` when a submission names its logo or social image; the admin listing
 * editor (#85) calls `hostListingMedia` when an admin changes one, and reads `submissionMedia`
 * / `listingMediaQueue` to show failures on the review screen.
 */
export async function mediaOperations(): Promise<MediaOperations> {
  const { env } = await getCloudflareContext({ async: true })
  return createWorkerMediaOperations(env as CloudflareEnv)
}

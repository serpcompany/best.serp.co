import 'server-only'

import { getCloudflareContext } from '@opennextjs/cloudflare'
import { createDatabase } from '@serpdirectory/data-ops/client'
import { resolveListingDetailMedia } from '@serpdirectory/data-ops/media-keys'
import { createSubmissionOperations } from '@serpdirectory/data-ops/submissions'
import type { WebsiteDetailMetadata } from '@serpdirectory/web-core/content-query'
import { mediaBaseUrl } from '../media/media-base'
import { reviewPreviewAccessSchema } from './review-preview'

const runtimeEnvironments = new Set(['local', 'staging', 'production'])

export async function getSubmissionReviewPreview(
  untrustedAccess: unknown
): Promise<WebsiteDetailMetadata | null> {
  const access = reviewPreviewAccessSchema.parse(untrustedAccess)
  const { env } = await getCloudflareContext({ async: true })
  const workerEnv = env as CloudflareEnv
  if (!workerEnv.DB) throw new Error('D1 binding DB is required for submission review previews.')
  if (!runtimeEnvironments.has(workerEnv.D1_RUNTIME_ENV)) {
    throw new Error('A valid D1_RUNTIME_ENV is required for submission review previews.')
  }
  const preview = await createSubmissionOperations({
    client: createDatabase(workerEnv.DB)
  }).getReviewPreview(access)
  // The logo is the submission's hosted copy on this environment's media host, or the fallback
  // tile: the submitted source is never rendered (#96 review S9).
  return preview && resolveListingDetailMedia(preview, await mediaBaseUrl())
}

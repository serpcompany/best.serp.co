import 'server-only'

import { getCloudflareContext } from '@opennextjs/cloudflare'
import { createSiteDatabase } from '@serpdirectory/data-ops/client'
import { createSubmissionOperations } from '@serpdirectory/data-ops/submissions'
import { resolveRuntimeSiteId } from '@serpdirectory/site-contract'
import type { WebsiteDetailMetadata } from '@serpdirectory/web-core/content-query'
import { reviewPreviewAccessSchema } from './review-preview'

const runtimeEnvironments = new Set(['local', 'preview', 'production'])

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
  const siteId = resolveRuntimeSiteId({
    NEXT_PUBLIC_SITE_ID: workerEnv.NEXT_PUBLIC_SITE_ID,
    SITE_ID: workerEnv.SITE_ID
  })
  return createSubmissionOperations({
    client: createSiteDatabase(workerEnv.DB, siteId)
  }).getReviewPreview(access)
}

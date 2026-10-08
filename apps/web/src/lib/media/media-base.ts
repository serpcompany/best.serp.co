import 'server-only'

import { getCloudflareContext } from '@opennextjs/cloudflare'
import { validateMediaBaseUrl } from '@serpdirectory/data-ops/media-keys'

/**
 * This environment's media host (`MEDIA_BASE_URL`, #95) for screens outside the catalog
 * adapter: the admin screens. Fails closed like the catalog does.
 */
export async function mediaBaseUrl(): Promise<string> {
  const { env } = await getCloudflareContext({ async: true })
  const workerEnv = env as CloudflareEnv
  return validateMediaBaseUrl(workerEnv.MEDIA_BASE_URL, workerEnv.D1_RUNTIME_ENV)
}

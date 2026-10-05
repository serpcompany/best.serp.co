import 'server-only'

import { getCloudflareContext } from '@opennextjs/cloudflare'
import { headers } from 'next/headers'
import { isPublicProduction } from './site-environment'

/**
 * Whether the current request is served as the public production site: the production Worker
 * (`SITE_ENVIRONMENT=production`) on best.serp.co. Read per request, never at module load.
 * Analytics load only then; on any error the answer is the safe one, `false`.
 *
 * Reading `host` cannot split or poison the edge HTML cache: the host is part of its key.
 */
export async function isPublicProductionRequest(): Promise<boolean> {
  try {
    const [{ env }, requestHeaders] = await Promise.all([
      getCloudflareContext({ async: true }),
      headers()
    ])
    return isPublicProduction(
      (env as Partial<CloudflareEnv>).SITE_ENVIRONMENT,
      requestHeaders.get('host')
    )
  } catch {
    return false
  }
}

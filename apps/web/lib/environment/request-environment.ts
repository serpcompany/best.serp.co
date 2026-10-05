import 'server-only'

import { getCloudflareContext } from '@opennextjs/cloudflare'
import { resolveGoogleTagManagerId } from '@serpdirectory/web-core/google-tag-manager'
import { siteConfig } from '@serpdirectory/web-core/site-config'
import { headers } from 'next/headers'
import { isPublicProduction } from './site-environment'

/**
 * Whether the current request is served as the public production site: the production Worker
 * (`SITE_ENVIRONMENT=production`) on best.serp.co. Read per request, never at module load.
 * On any error the answer is the safe one, `false`, and the error is logged.
 *
 * Reading `host` cannot split or poison the edge HTML cache: for a cacheable request the
 * Worker sets it to the host of the cache key (`renderRequestFor`).
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
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'site_environment_error',
        message: error instanceof Error ? error.message : String(error)
      })
    )
    return false
  }
}

/**
 * The Google Tag Manager container the root layout renders: the site's container on the public
 * production site, none anywhere else (local, staging, the production Worker's workers.dev
 * host), so CI and reviewer traffic never reach production analytics.
 */
export async function googleTagManagerIdForRequest(): Promise<string | undefined> {
  return (await isPublicProductionRequest()) ? resolveGoogleTagManagerId(siteConfig) : undefined
}

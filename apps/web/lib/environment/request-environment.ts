import 'server-only'

import { getCloudflareContext } from '@opennextjs/cloudflare'
import { resolveGoogleTagManagerId } from '@serpdirectory/web-core/google-tag-manager'
import { siteConfig } from '@serpdirectory/web-core/site-config'
import { headers } from 'next/headers'
import { isPublicProduction } from './site-environment'

/**
 * The Worker env when the current request is served as the public production site: the
 * production Worker (`SITE_ENVIRONMENT=production`) on best.serp.co, else null. Read per
 * request, never at module load. On any error the answer is the safe one, null, and the error
 * is logged.
 *
 * Reading `host` cannot split or poison the edge HTML cache: for a cacheable request the
 * Worker sets it to the host of the cache key (`renderRequestFor`).
 */
async function publicProductionEnv(): Promise<Partial<CloudflareEnv> | null> {
  try {
    const [{ env }, requestHeaders] = await Promise.all([
      getCloudflareContext({ async: true }),
      headers()
    ])
    const workerEnv = env as Partial<CloudflareEnv>
    return isPublicProduction(workerEnv.SITE_ENVIRONMENT, requestHeaders.get('host'))
      ? workerEnv
      : null
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'site_environment_error',
        message: error instanceof Error ? error.message : String(error)
      })
    )
    return null
  }
}

/** Whether the current request is served as the public production site. */
export async function isPublicProductionRequest(): Promise<boolean> {
  return (await publicProductionEnv()) !== null
}

/** A Cloudflare Web Analytics site token: 32 hex characters, public, not a secret. */
const WEB_ANALYTICS_TOKEN = /^[0-9a-f]{32}$/u

export type RequestAnalytics = {
  /** The Cloudflare Web Analytics beacon's site token (#170). */
  cloudflareWebAnalyticsToken?: string
  gtmId?: string
}

/**
 * The analytics the root layout renders: on the public production site, the site's Google
 * Tag Manager container and, when `CF_WEB_ANALYTICS_TOKEN` holds a site token, the Cloudflare
 * Web Analytics beacon (#170); nothing anywhere else (local, staging, the production Worker's
 * workers.dev host), so CI and reviewer traffic never reach production analytics.
 */
export async function analyticsForRequest(): Promise<RequestAnalytics> {
  const env = await publicProductionEnv()
  if (!env) return {}
  const token = env.CF_WEB_ANALYTICS_TOKEN?.trim()
  return {
    ...(token && WEB_ANALYTICS_TOKEN.test(token) ? { cloudflareWebAnalyticsToken: token } : {}),
    gtmId: resolveGoogleTagManagerId(siteConfig)
  }
}

import { getCloudflareContext } from '@opennextjs/cloudflare'
import { CANONICAL_ORIGIN, type SiteEnvironmentEnv, siteOriginFor } from './site-environment'

/**
 * The origin this request's pages, sitemaps, and feed write in their absolute URLs
 * (`siteOriginFor`): `https://staging.best.serp.co` on a Worker that serves as staging (#359),
 * `https://best.serp.co` everywhere else. It is read from the Worker's vars through OpenNext's
 * request context, synchronously, so metadata and JSON-LD builders can call it anywhere during
 * a request; never from the `Host` header.
 *
 * Outside a request (unit tests, the build's prerender of the static robots.txt route) there is
 * no context, and the answer is production's origin, which is what every page wrote before #359.
 * Every route that renders per request is dynamic (the root layout reads the request), so a
 * page never bakes in that fallback.
 */
export function siteOrigin(): string {
  let env: SiteEnvironmentEnv | undefined
  try {
    env = getCloudflareContext().env as SiteEnvironmentEnv | undefined
  } catch {
    return CANONICAL_ORIGIN
  }
  return siteOriginFor(env)
}

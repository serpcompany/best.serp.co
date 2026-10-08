/**
 * URLs the site retired without a replacement answer 410 Gone (serp web-stack/nextjs-on-workers.md,
 * The Worker entry: pages can't answer 410). The Worker answers before the trailing-slash rule,
 * so each takes no redirect first (#166).
 */
const RETIRED_PATHS: ReadonlySet<string> = new Set(['/news'])

export function retiredPathResponse(request: Request): Response | null {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null
  const path = new URL(request.url).pathname.replace(/\/+$/u, '') || '/'
  if (!RETIRED_PATHS.has(path)) return null
  return new Response('This page has been removed.\n', {
    headers: {
      'cache-control': 'public, max-age=3600',
      'content-type': 'text/plain; charset=utf-8'
    },
    status: 410,
    statusText: 'Gone'
  })
}

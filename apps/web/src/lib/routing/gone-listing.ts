/**
 * 410 Gone for unpublished listings (serpcompany/best.serp.co#64 owner decision): an
 * unpublished listing's URL answers 410 with a page that points to its category, not 404.
 *
 * Next.js pages can answer 200 or 404 but not 410, so the Worker entry sets the status. A
 * listing page for a slug with no public listing renders 404 as before. Only then does the Worker
 * ask D1 whether the slug is unpublished (`isUnpublishedListingSlug`, one index seek); if it is,
 * it renders the page once more with `GONE_RENDER_HEADER`, which makes the page render the gone
 * page instead of `notFound()`, and answers that with status 410. The edge cache stores the 410
 * under the catalog epoch, which unpublishing and republishing advance.
 *
 * The header is not a secret: the gone page is public, and the page renders it only for a slug
 * that is unpublished. Still, only the Worker's own second render may carry it:
 * `goneListingRenderer` strips it from every incoming request, so a client cannot turn the 410
 * into a 200 for itself on a request that bypasses the edge cache (#64 review).
 */
export const GONE_RENDER_HEADER = 'x-best-serp-co-render-gone'

/** The request without `GONE_RENDER_HEADER`. */
export function withoutGoneRenderHeader(request: Request): Request {
  if (!request.headers.has(GONE_RENDER_HEADER)) return request
  const headers = new Headers(request.headers)
  headers.delete(GONE_RENDER_HEADER)
  return new Request(request, { headers })
}

/**
 * The Worker's renderer: strips `GONE_RENDER_HEADER` from the incoming request, renders it, and
 * turns an unpublished listing's 404 into the 410 gone page. Without `isUnpublished` (no valid
 * D1 binding) the 404 stands.
 */
export function goneListingRenderer(
  render: (request: Request) => Promise<Response>,
  isUnpublished?: (slug: string) => Promise<boolean>
): (request: Request) => Promise<Response> {
  return async incoming => {
    const request = withoutGoneRenderHeader(incoming)
    const response = await render(request)
    return isUnpublished ? withGoneListing(request, response, { isUnpublished, render }) : response
  }
}

const LISTING_PATH = /^\/products\/([^/]+)\/$/u

/** The listing slug of a listing page path (`/products/<slug>/`), or null. */
export function listingSlugFromPath(pathname: string): string | null {
  const match = LISTING_PATH.exec(pathname)
  if (!match?.[1]) return null
  let slug: string
  try {
    slug = decodeURIComponent(match[1])
  } catch {
    return null
  }
  // `/products/categories/` is the category index, not a listing.
  if (slug === 'categories' || slug.length > 253) return null
  return slug
}

export interface GoneListingDependencies {
  isUnpublished: (slug: string) => Promise<boolean>
  render: (request: Request) => Promise<Response>
}

/** Turns a listing page's 404 into the 410 gone page when the listing is unpublished. */
export async function withGoneListing(
  request: Request,
  response: Response,
  dependencies: GoneListingDependencies
): Promise<Response> {
  if (response.status !== 404) return response
  if (request.method !== 'GET' && request.method !== 'HEAD') return response
  const slug = listingSlugFromPath(new URL(request.url).pathname)
  if (!slug) return response
  let unpublished = false
  try {
    unpublished = await dependencies.isUnpublished(slug)
  } catch {
    return response
  }
  if (!unpublished) return response
  const headers = new Headers(request.headers)
  headers.set(GONE_RENDER_HEADER, '1')
  const gone = await dependencies.render(new Request(request, { headers }))
  if (gone.status !== 200) return response
  await response.body?.cancel()
  return new Response(gone.body, { headers: gone.headers, status: 410, statusText: 'Gone' })
}

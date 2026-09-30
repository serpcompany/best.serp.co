import { getRoute } from '@serpdirectory/web-core/routes'
import { getAutocomplete } from '@/lib/catalog/repository'

export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const query = url.searchParams.get('q')?.trim() || ''
  const requestedLimit = Number(url.searchParams.get('limit') || 20)
  const limit = Number.isSafeInteger(requestedLimit)
    ? Math.min(1000, Math.max(1, requestedLimit))
    : 20
  if (!query) return Response.json([])

  const listings = await getAutocomplete(query, limit)
  return Response.json(
    listings.map(listing => ({
      category: listing.category,
      categories: listing.categories,
      description: listing.description,
      name: listing.name,
      slug: listing.slug,
      url: getRoute('listing.detail', { slug: listing.slug }),
      website: listing.website
    })),
    { headers: { 'Cache-Control': 'private, max-age=30' } }
  )
}

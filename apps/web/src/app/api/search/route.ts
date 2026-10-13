import { getAutocompleteWithCategories, MAX_SEARCH_LIMIT } from '@/lib/catalog/repository'
import { categoryNamesBySlug } from '@/lib/directory/categories'
import { getRoute } from '@/lib/routing/routes'

export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const query = url.searchParams.get('q')?.trim() || ''
  const requestedLimit = Number(url.searchParams.get('limit') || 20)
  const limit = Number.isSafeInteger(requestedLimit)
    ? Math.min(MAX_SEARCH_LIMIT, Math.max(1, requestedLimit))
    : 20
  if (!query) return Response.json([])

  // Each result names its categories as D1 does, from the cached shell stats, for the search
  // page's filters (#416). One read sets up D1 access once for both.
  const { categories, listings } = await getAutocompleteWithCategories(query, limit)
  const names = categoryNamesBySlug(categories)
  return Response.json(
    listings.map(listing => ({
      category: listing.category,
      categories: listing.categories,
      categoryNames: Object.fromEntries(
        [listing.category, ...(listing.categories ?? [])].flatMap(slug => {
          const name = names.get(slug)
          return name ? [[slug, name]] : []
        })
      ),
      description: listing.description,
      name: listing.name,
      slug: listing.slug,
      url: getRoute('listing.detail', { slug: listing.slug }),
      website: listing.website
    })),
    { headers: { 'Cache-Control': 'private, max-age=30' } }
  )
}

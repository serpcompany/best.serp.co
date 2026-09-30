import { getRoute } from '@serpdirectory/web-core/routes'
import { notFound, permanentRedirect } from 'next/navigation'
import { getCategoryBySlug } from '@/lib/catalog/repository'
import { getWebsiteBySlug } from '@/lib/content-loader'

interface LegacyListingRouteProps {
  params: Promise<{ slug: string }>
}

export default async function LegacyListingRoute({ params }: LegacyListingRouteProps) {
  const { slug } = await params
  const listing = await getWebsiteBySlug(slug)

  if (listing) {
    permanentRedirect(getRoute('listing.detail', { slug: listing.slug }))
  }

  const category = await getCategoryBySlug(slug)
  if (category) {
    permanentRedirect(getRoute('category.page', { category: category.slug }))
  }

  notFound()
}

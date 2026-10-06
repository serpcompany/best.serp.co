import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { AdminCrumbs } from '@/components/admin/admin-shell'
import { ListingDetail } from '@/components/admin/listing-detail'
import { listingDetailView } from '@/lib/admin/listing-view'
import { getAdminReads } from '@/lib/admin/runtime'
import { requireAdmin } from '@/lib/auth/server'
import { mediaBaseUrl } from '@/lib/media/media-base'

/** One listing (#64 screen 12). */
export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Listing' }

interface Props {
  params: Promise<{ slug: string }>
}

export default async function AdminListingPage({ params }: Props) {
  await requireAdmin()
  const slug = decodeURIComponent((await params).slug)
    .trim()
    .toLowerCase()
  if (!slug || slug.length > 253) notFound()
  const reads = await getAdminReads()
  const [listing, categories] = await Promise.all([
    reads.getAdminListing(slug),
    reads.listActiveCategories()
  ])
  if (!listing) notFound()
  return (
    <>
      <AdminCrumbs
        crumbs={[
          { href: '/admin/', label: 'Admin' },
          { href: '/admin/listings/', label: 'Listings' },
          { label: listing.name }
        ]}
      />

      <ListingDetail
        categories={categories}
        view={listingDetailView(listing, await mediaBaseUrl())}
      />
    </>
  )
}

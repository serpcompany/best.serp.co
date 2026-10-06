import { generateBaseMetadata } from '@serpdirectory/web-core/seo-config'
import type { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'
import type { ReactElement } from 'react'
import { AccountTablePage, accountTableRows } from '@/components/account/account-table-page'
import { getAccountOverview } from '@/lib/account/overview'
import { requireAccountUser } from '@/lib/account/pages'
import { ACCOUNT_ID } from '@/lib/account/requests'

export const metadata: Metadata = generateBaseMetadata({
  title: 'Listing',
  description: 'Your listing on SERP.',
  path: '/account/listings/',
  noindex: true
})

type ListingPageProps = { params: Promise<{ slug: string }> }

/**
 * `/account/listings/<slug>/` (#65): a free listing opens with its badge panel over the
 * listings (the badge emails link here, #66); any other listing goes to its edit page. Someone
 * else's listing is a 404.
 */
export default async function AccountListingPage({
  params
}: ListingPageProps): Promise<ReactElement> {
  const { slug } = await params
  const user = await requireAccountUser(`/account/listings/${slug}/`)
  const rows = await accountTableRows(await getAccountOverview(user.id))
  const row = rows.find(item => item.kind === 'listing' && item.slug === slug)
  if (!row || !ACCOUNT_ID.test(row.id)) notFound()
  if (!row.badge) redirect(`/account/listings/${slug}/edit/`)
  return <AccountTablePage initialBadge={row.badge.listingId} rows={rows} scope="listings" />
}

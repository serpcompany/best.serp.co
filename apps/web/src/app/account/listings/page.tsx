import { generateBaseMetadata } from '@serpdirectory/web-core/seo-config'
import type { Metadata } from 'next'
import type { ReactElement } from 'react'
import { AccountTablePage, accountTableRows } from '@/components/account/account-table-page'
import { getAccountOverview } from '@/lib/account/overview'
import { requireAccountUser } from '@/lib/account/pages'

export const metadata: Metadata = generateBaseMetadata({
  title: 'Listings',
  description: 'Your listings on SERP.',
  path: '/account/listings/',
  noindex: true
})

/** `/account/listings/` (#65): the screen-5 table with the listings the user owns. */
export default async function AccountListingsPage(): Promise<ReactElement> {
  const user = await requireAccountUser('/account/listings/')
  const rows = await accountTableRows(await getAccountOverview(user.id))
  return <AccountTablePage rows={rows} scope="listings" />
}

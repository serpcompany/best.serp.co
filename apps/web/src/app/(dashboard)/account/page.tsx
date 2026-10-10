import type { Metadata } from 'next'
import type { ReactElement } from 'react'
import { AccountTablePage, accountTableRows } from '@/components/account/account-table-page'
import { getAccountOverview } from '@/lib/account/overview'
import { requireAccountUser } from '@/lib/account/pages'
import { getRoute } from '@/lib/routing/routes'
import { generateBaseMetadata } from '@/lib/seo/seo-config'

export function generateMetadata(): Metadata {
  return generateBaseMetadata({
    title: 'Account',
    description: 'Your SERP account.',
    path: '/account/',
    noindex: true
  })
}

/**
 * `/account` (#60, #65; #70 screen 5): the section cards and the table of the user's
 * submissions and listings, each with its status and next step, and the badge panel of a free
 * listing. With nothing yet, the empty state. Signed-out visitors go to `/login` and come back.
 */
export default async function AccountPage(): Promise<ReactElement> {
  const user = await requireAccountUser(getRoute('account'))
  const rows = await accountTableRows(await getAccountOverview(user.id))
  return <AccountTablePage rows={rows} scope="overview" />
}

import type { Metadata } from 'next'
import type { ReactElement } from 'react'
import { AccountTablePage, accountTableRows } from '@/components/account/account-table-page'
import { getAccountOverview } from '@/lib/account/overview'
import { requireAccountUser } from '@/lib/account/pages'
import { generateBaseMetadata } from '@/lib/seo/seo-config'

export function generateMetadata(): Metadata {
  return generateBaseMetadata({
    title: 'Submissions',
    description: 'Your submissions to SERP.',
    path: '/account/submissions/',
    noindex: true
  })
}

/** `/account/submissions/` (#65): the screen-5 table with the user's submissions only. */
export default async function AccountSubmissionsPage(): Promise<ReactElement> {
  const user = await requireAccountUser('/account/submissions/')
  const rows = await accountTableRows(await getAccountOverview(user.id))
  return <AccountTablePage rows={rows} scope="submissions" />
}

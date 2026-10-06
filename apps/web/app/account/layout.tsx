import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { AccountShell } from '@/components/account/account-shell'
import { getAccountOverview } from '@/lib/account/overview'
import { accountRows, type BadgeTarget } from '@/lib/account/view'
import { getSessionUser } from '@/lib/auth/server'
import { ordersEnabled } from '@/lib/billing/runtime'
import { requireRouteFeature } from '@/lib/route-feature-gates'

/**
 * The account area (#60, #65): the dashboard-01 shell from the #70 mockups around every
 * `/account` page. Pages are never indexed, never cached at the edge (the Worker bypasses
 * `/account`), and each one calls `requireAccountUser()` itself, which sends signed-out
 * visitors to `/login` and back; the shell renders only for a signed-in user.
 */
export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  referrer: 'no-referrer',
  robots: { follow: false, index: false, nocache: true }
}

const noBadge: BadgeTarget = () => ({ badgeUrl: '', listingUrl: '' })

export default async function AccountLayout({ children }: { children: ReactNode }) {
  requireRouteFeature('showAuth')
  const user = await getSessionUser()
  if (!user) return children
  const rows = accountRows(await getAccountOverview(user.id), {
    badgeTarget: noBadge,
    now: new Date(),
    showPaid: await ordersEnabled()
  })
  return (
    <AccountShell
      submissionsNeedingAction={
        rows.filter(row => row.kind === 'submission' && row.tab === 'action').length
      }
      user={{ email: user.email, name: user.name }}
    >
      {children}
    </AccountShell>
  )
}

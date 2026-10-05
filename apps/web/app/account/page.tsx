import { Button } from '@serpdirectory/design-system/button'
import { Card, CardContent } from '@serpdirectory/design-system/card'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@serpdirectory/design-system/empty'
import { DashboardPageHeader } from '@serpdirectory/web-core/dashboard/page-header'
import { getRoute } from '@serpdirectory/web-core/routes'
import { generateBaseMetadata } from '@serpdirectory/web-core/seo-config'
import { Inbox, Plus, Search } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import type { ReactElement } from 'react'
import { AccountShell } from '@/components/account/account-shell'
import { getSessionUser } from '@/lib/auth/server'
import { requireRouteFeature } from '@/lib/route-feature-gates'

export const metadata: Metadata = generateBaseMetadata({
  title: 'Account',
  description: 'Your SERP account.',
  path: '/account/',
  noindex: true
})

/**
 * `/account` (serpcompany/best.serp.co#60): the dashboard shell approved in #70 with the
 * signed-in user and sign-out. Its content is the overview heading and the mockup's empty state
 * (a compact Empty in a Card) until #65 builds the submissions and listings it will list.
 * Signed-out visitors go to `/login` and come back.
 */
export default async function AccountPage(): Promise<ReactElement> {
  requireRouteFeature('showAuth')
  const user = await getSessionUser()
  if (!user) {
    redirect(`${getRoute('login')}?callbackUrl=${encodeURIComponent(getRoute('account'))}`)
  }
  return (
    <AccountShell user={{ email: user.email, name: user.name }}>
      <DashboardPageHeader title="Overview" description="Your submissions and listings on SERP." />
      <Card className="py-0">
        <CardContent className="px-0">
          <Empty className="p-8 md:p-10">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Inbox />
              </EmptyMedia>
              <EmptyTitle>No listings yet</EmptyTitle>
              <EmptyDescription>
                Submit your product to get it reviewed and listed. Already on SERP? Find its listing
                and claim it.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <div className="flex flex-wrap justify-center gap-2">
                <Button asChild>
                  <Link href={getRoute('submit')}>
                    <Plus />
                    Submit a product
                  </Link>
                </Button>
                <Button asChild variant="outline">
                  <Link href={getRoute('search')}>
                    <Search />
                    Find your listing
                  </Link>
                </Button>
              </div>
            </EmptyContent>
          </Empty>
        </CardContent>
      </Card>
    </AccountShell>
  )
}

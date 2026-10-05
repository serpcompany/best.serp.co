import { Button } from '@serpdirectory/design-system/button'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@serpdirectory/design-system/empty'
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
 * signed-in user and sign-out. Its content is the mockup's empty overview until #65 builds the
 * submissions and listings it will list. Signed-out visitors go to `/login` and come back.
 */
export default async function AccountPage(): Promise<ReactElement> {
  requireRouteFeature('showAuth')
  const user = await getSessionUser()
  if (!user) {
    redirect(`${getRoute('login')}?callbackUrl=${encodeURIComponent(getRoute('account'))}`)
  }
  return (
    <AccountShell user={{ email: user.email, name: user.name }}>
      <h1 className="sr-only">Account overview</h1>
      <Empty className="min-h-[420px] border border-dashed">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Inbox />
          </EmptyMedia>
          <EmptyTitle>No listings yet</EmptyTitle>
          <EmptyDescription>
            Submit your product to get it reviewed and listed. Already on SERP? Find its listing and
            claim it.
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
    </AccountShell>
  )
}

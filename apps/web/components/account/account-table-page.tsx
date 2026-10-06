import type { AccountOverview } from '@serpdirectory/data-ops/account'
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
import { site } from '@serpdirectory/site-config'
import { DashboardPageHeader } from '@serpdirectory/web-core/dashboard/page-header'
import { getRoute } from '@serpdirectory/web-core/routes'
import { Inbox, Plus, Search } from 'lucide-react'
import Link from 'next/link'
import type { ReactElement } from 'react'
import { accountBadgeTarget, badgePanelCopy, badgeSiteName } from '@/lib/account/presentation'
import { type AccountRow, accountCards, accountRows } from '@/lib/account/view'
import { featureCopy } from '@/lib/feature-copy'
import { features } from '@/lib/features'
import { AccountDashboard } from './account-dashboard'
import { AccountCrumbs } from './account-shell'
import { statusLegend } from './status'

/**
 * An account page with the screen-5 table (#65): the overview (with the section cards), or the
 * Submissions or Listings page (the same table, one kind of row). With nothing to show, the
 * mockup's empty state in a compact card (#83, owner-approved).
 */

const SCOPES = {
  listings: {
    crumb: 'Listings',
    description: 'Your listings on best.serp.co.',
    empty: {
      description: 'When a submission is approved, its listing shows up here.',
      title: 'No listings yet'
    },
    noun: 'listings',
    title: 'Listings'
  },
  overview: {
    crumb: 'Overview',
    description: 'Your submissions and listings on SERP.',
    empty: {
      description:
        'Submit your product to get it reviewed and listed. Already on SERP? Find its listing and claim it.',
      title: 'No listings yet'
    },
    noun: 'submissions and listings',
    title: 'Overview'
  },
  submissions: {
    crumb: 'Submissions',
    description: 'Everything you’ve submitted to SERP.',
    empty: {
      description: 'Submit your product to get it reviewed and listed.',
      title: 'No submissions yet'
    },
    noun: 'submissions',
    title: 'Submissions'
  }
} as const

export function accountTableRows(overview: AccountOverview): AccountRow[] {
  return accountRows(overview, {
    badgeTarget: accountBadgeTarget,
    now: new Date(),
    showPaid: site.features.showPaidListings
  })
}

export function AccountTablePage({
  initialBadge = null,
  rows,
  scope
}: {
  initialBadge?: string | null
  rows: readonly AccountRow[]
  scope: keyof typeof SCOPES
}): ReactElement {
  const copy = SCOPES[scope]
  const shown =
    scope === 'overview'
      ? rows
      : rows.filter(row => row.kind === (scope === 'listings' ? 'listing' : 'submission'))
  const flagged = featureCopy().badgePanel
  return (
    <>
      <AccountCrumbs
        crumbs={[{ href: getRoute('account'), label: 'Account' }, { label: copy.crumb }]}
      />
      <DashboardPageHeader title={copy.title} description={copy.description} />
      {shown.length === 0 ? (
        <Card className="py-0">
          <CardContent className="px-0">
            <Empty className="p-8 md:p-10">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Inbox />
                </EmptyMedia>
                <EmptyTitle>{copy.empty.title}</EmptyTitle>
                <EmptyDescription>{copy.empty.description}</EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <div className="flex flex-wrap justify-center gap-2">
                  <Button asChild>
                    <Link href={getRoute('submit')}>
                      <Plus />
                      Submit a product
                    </Link>
                  </Button>
                  {scope === 'overview' ? (
                    <Button asChild variant="outline">
                      <Link href={getRoute('search')}>
                        <Search />
                        Find your listing
                      </Link>
                    </Button>
                  ) : null}
                </div>
              </EmptyContent>
            </Empty>
          </CardContent>
        </Card>
      ) : (
        <AccountDashboard
          badgeCopy={{ ...badgePanelCopy(), cadence: flagged.cadence, cardNote: flagged.cardNote }}
          cards={scope === 'overview' ? accountCards(shown) : null}
          initialBadge={initialBadge}
          legend={statusLegend({
            badgeProgram: features.badgeProgram,
            messages: features.messages,
            showPaid: site.features.showPaidListings
          })}
          noun={copy.noun}
          rows={shown}
          siteName={badgeSiteName}
          submitHref={getRoute('submit')}
        />
      )}
    </>
  )
}

'use client'

import { Badge } from '@serpdirectory/design-system/badge'
import { Button } from '@serpdirectory/design-system/button'
import {
  Card,
  CardAction,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle
} from '@serpdirectory/design-system/card'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger
} from '@serpdirectory/design-system/collapsible'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@serpdirectory/design-system/dropdown-menu'
import { cn } from '@serpdirectory/design-system/lib/utils'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@serpdirectory/design-system/select'
import { Tabs, TabsList, TabsTrigger } from '@serpdirectory/design-system/tabs'
import {
  type ColumnDef,
  getCoreRowModel,
  getPaginationRowModel,
  type PaginationState,
  useReactTable,
  type VisibilityState
} from '@tanstack/react-table'
import {
  ChevronDown,
  ChevronsUpDown,
  CircleCheck,
  Clock,
  Columns3,
  EllipsisVertical,
  Loader,
  Plus,
  ShieldCheck,
  TriangleAlert
} from 'lucide-react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { type ReactNode, useMemo, useState } from 'react'
import { DataTableView, PaginationFooter } from '@/components/admin/data-table'
import { ProductLogo } from '@/components/submit/submit-ui'
import { formatShort } from '@/lib/account/format'
import type { AccountCards, AccountRow, AccountStatus, AccountTab } from '@/lib/account/view'
import { BadgeDrawer, type BadgePanelCopy } from './badge-drawer'
import { AccountStatusBadge, PlanCell } from './status'
import { WithdrawDialog } from './withdraw-dialog'

/**
 * The account's table of submissions and listings (#70 screen 5, dashboard-01): section cards on
 * the overview, status tabs (a Select on narrow screens), the Columns menu, the data table with
 * each row's next step, action, and row menu, the pagination footer, the status legend, and the
 * badge panel of a free listing.
 */

type Filter = 'action' | 'all' | 'closed' | 'live'

const FILTERS: ReadonlyArray<[Filter, string]> = [
  ['all', 'All'],
  ['action', 'Needs action'],
  ['live', 'Live'],
  ['closed', 'Closed']
]

function inFilter(row: AccountRow, filter: Filter): boolean {
  if (filter === 'all') return true
  return row.tab === (filter as AccountTab)
}

const COLUMN_LABELS: Record<string, string> = { next: 'Next step', plan: 'Plan', status: 'Status' }

function joinNames(names: readonly string[]): string {
  if (names.length <= 3) return names.join(', ')
  return `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`
}

function SectionCard({
  badge,
  description,
  footer,
  note,
  title
}: {
  badge: ReactNode
  description: string
  footer: string
  note: string
  title: string
}) {
  return (
    <Card className="@container/card gap-4">
      <CardHeader>
        <CardDescription>{description}</CardDescription>
        <CardTitle className="text-2xl font-semibold tabular-nums">{title}</CardTitle>
        {badge ? <CardAction>{badge}</CardAction> : null}
      </CardHeader>
      <CardFooter className="flex-col items-start gap-1.5 text-sm">
        <div className="line-clamp-1 flex gap-2 font-medium">{footer}</div>
        <div className="text-muted-foreground">{note}</div>
      </CardFooter>
    </Card>
  )
}

function SectionCards({
  cards,
  cadence,
  cardNote
}: {
  cadence: string | null
  cardNote: string
  cards: AccountCards
}) {
  const failing = cards.badges.failing
  const checked = cards.badges.lastChecked?.badge?.last
  return (
    <div className="grid grid-cols-1 gap-4 *:data-[slot=card]:bg-gradient-to-t *:data-[slot=card]:from-primary/5 *:data-[slot=card]:to-card *:data-[slot=card]:shadow-xs @xl/main:grid-cols-2 @5xl/main:grid-cols-4 dark:*:data-[slot=card]:bg-card">
      <SectionCard
        badge={
          <Badge variant="outline">
            <Clock />
            To do
          </Badge>
        }
        description="Needs your action"
        footer={cards.action.count > 0 ? joinNames(cards.action.names) : 'Nothing to do'}
        note="Finish or fix these to get reviewed"
        title={String(cards.action.count)}
      />
      <SectionCard
        badge={
          <Badge variant="outline">
            <Loader />
            Queued
          </Badge>
        }
        description="In review"
        footer={cards.review.count > 0 ? joinNames(cards.review.names) : 'Nothing in review'}
        note="We email you when it’s reviewed"
        title={String(cards.review.count)}
      />
      <SectionCard
        badge={
          cards.live.paid > 0 ? (
            <Badge variant="outline">
              <CircleCheck />
              {cards.live.paid} paid
            </Badge>
          ) : null
        }
        description="Live"
        footer={cards.live.count > 0 ? joinNames(cards.live.names) : 'Nothing live yet'}
        note="Visible on best.serp.co"
        title={String(cards.live.count)}
      />
      {failing.length > 0 ? (
        <SectionCard
          badge={
            <Badge variant="outline">
              <TriangleAlert className="text-amber-500" />
              Fix needed
            </Badge>
          }
          description="Badge checks"
          footer={failing
            .map(row => `${row.name}: ${row.next.text.replace(/^Badge failing: /u, '')}`)
            .join(', ')}
          note="Fix the badge, then check it again"
          title={`${failing.length} failing`}
        />
      ) : (
        <SectionCard
          badge={
            cadence ? (
              <Badge variant="outline">
                <CircleCheck />
                {cadence}
              </Badge>
            ) : null
          }
          description="Badge checks"
          footer={
            cards.badges.lastChecked && checked
              ? `${cards.badges.lastChecked.name} checked ${new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'short', timeZone: 'UTC', weekday: 'short' }).format(Date.parse(checked.at))}`
              : cards.badges.free.length > 0
                ? 'Not checked yet'
                : 'No free listings yet'
          }
          note={cardNote}
          title={cards.badges.free.length > 0 ? 'Passing' : '—'}
        />
      )}
    </div>
  )
}

function StatusLegend({ legend }: { legend: ReadonlyArray<[AccountStatus, string]> }) {
  return (
    <Collapsible defaultOpen className="rounded-lg border">
      <div className="flex items-center justify-between px-4 py-3">
        <p className="text-sm font-medium">What the statuses mean</p>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="icon" className="size-8">
            <ChevronsUpDown />
            <span className="sr-only">Toggle</span>
          </Button>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent>
        <dl className="grid gap-x-6 gap-y-3 border-t p-4 text-sm @md/main:grid-cols-2">
          {legend.map(([status, text]) => (
            <div key={status} className="flex flex-col items-start gap-1.5">
              <dt>
                <AccountStatusBadge status={status} />
              </dt>
              <dd className="text-muted-foreground">{text}</dd>
            </div>
          ))}
        </dl>
      </CollapsibleContent>
    </Collapsible>
  )
}

export function AccountDashboard({
  badgeCopy,
  cards,
  initialBadge = null,
  legend,
  noun,
  rows,
  siteName,
  submitHref
}: {
  badgeCopy: BadgePanelCopy & { cadence: string | null; cardNote: string }
  cards: AccountCards | null
  /** The listing id whose badge panel opens with the page (`/account/listings/<slug>/`). */
  initialBadge?: string | null
  legend: ReadonlyArray<[AccountStatus, string]>
  /** "submissions and listings", "submissions", or "listings". */
  noun: string
  rows: readonly AccountRow[]
  siteName: string
  submitHref: string
}) {
  const router = useRouter()
  const pathname = usePathname()
  const [filter, setFilter] = useState<Filter>('all')
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 10 })
  const [visibility, setVisibility] = useState<VisibilityState>({})
  const [badgeFor, setBadgeFor] = useState<string | null>(initialBadge)
  const [withdrawing, setWithdrawing] = useState<AccountRow | null>(null)

  const counts = Object.fromEntries(
    FILTERS.map(([key]) => [key, rows.filter(row => inFilter(row, key)).length])
  ) as Record<Filter, number>
  const filtered = useMemo(() => rows.filter(row => inFilter(row, filter)), [rows, filter])
  const badgeRow = rows.find(row => row.badge?.listingId === badgeFor) ?? null

  function closeBadge() {
    setBadgeFor(null)
    // The listing's own URL opens with its panel; closing returns to the listings.
    if (/^\/account\/listings\/[^/]+\/$/u.test(pathname ?? '')) {
      router.replace('/account/listings/', { scroll: false })
    }
  }

  const columns = useMemo<ColumnDef<AccountRow>[]>(
    () => [
      {
        cell: ({ row }) => (
          <div className="flex items-center gap-3">
            <ProductLogo
              className="rounded-sm"
              name={row.original.name}
              size={32}
              src={row.original.logoUrl}
            />
            <div className="min-w-0">
              <Link href={row.original.href} className="font-medium hover:underline">
                {row.original.name}
              </Link>
              <p className="text-xs text-muted-foreground">
                {row.original.host}
                {row.original.date ? ` · ${formatShort(row.original.date)}` : ''}
              </p>
            </div>
          </div>
        ),
        enableHiding: false,
        header: 'Product',
        id: 'product'
      },
      {
        cell: ({ row }) => (
          <div className="flex flex-col items-start gap-1">
            <AccountStatusBadge status={row.original.status} />
            {row.original.draftExpiresInDays !== null ? (
              <span className="text-xs text-muted-foreground">
                Expires in {row.original.draftExpiresInDays}{' '}
                {row.original.draftExpiresInDays === 1 ? 'day' : 'days'}
              </span>
            ) : null}
          </div>
        ),
        header: 'Status',
        id: 'status'
      },
      { cell: ({ row }) => <PlanCell plan={row.original.plan} />, header: 'Plan', id: 'plan' },
      {
        cell: ({ row }) => (
          <span
            className={cn(
              row.original.next.tone === 'warning'
                ? 'text-amber-700 dark:text-amber-400'
                : 'text-muted-foreground'
            )}
          >
            {row.original.next.text}
          </span>
        ),
        header: 'Next step',
        id: 'next'
      },
      {
        cell: ({ row }) => {
          const item = row.original
          const action = item.action
          return (
            <div className="flex items-center justify-end gap-1">
              {action === 'badge' ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setBadgeFor(item.badge?.listingId ?? null)}
                >
                  <ShieldCheck />
                  Badge
                </Button>
              ) : action ? (
                <Button asChild size="sm" variant={action.variant}>
                  {action.checkout ? (
                    // A plain link: the checkout route opens a provider checkout (#68).
                    <a href={action.href}>{action.label}</a>
                  ) : (
                    <Link href={action.href}>{action.label}</Link>
                  )}
                </Button>
              ) : null}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="size-8 text-muted-foreground">
                    <EllipsisVertical />
                    <span className="sr-only">Open menu for {item.name}</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
                  <DropdownMenuItem asChild>
                    <Link href={item.href}>
                      {item.kind === 'listing' ? 'Edit listing' : 'View details'}
                    </Link>
                  </DropdownMenuItem>
                  {item.kind === 'listing' && item.status === 'live' ? (
                    <DropdownMenuItem asChild>
                      <a href={`/products/${item.slug}/`} target="_blank" rel="noreferrer">
                        View live listing
                      </a>
                    </DropdownMenuItem>
                  ) : null}
                  {item.menu.withdraw || item.menu.messageUs ? <DropdownMenuSeparator /> : null}
                  {item.menu.withdraw ? (
                    <DropdownMenuItem variant="destructive" onSelect={() => setWithdrawing(item)}>
                      Withdraw
                    </DropdownMenuItem>
                  ) : null}
                  {item.menu.messageUs ? (
                    <DropdownMenuItem asChild>
                      <Link href="/contact/">Message us</Link>
                    </DropdownMenuItem>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )
        },
        enableHiding: false,
        header: () => <span className="sr-only">Actions</span>,
        id: 'actions'
      }
    ],
    []
  )

  const table = useReactTable({
    columns,
    data: filtered,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getRowId: row => row.key,
    onColumnVisibilityChange: setVisibility,
    onPaginationChange: setPagination,
    state: { columnVisibility: visibility, pagination }
  })

  const choose = (value: string) => {
    setFilter(value as Filter)
    setPagination(current => ({ ...current, pageIndex: 0 }))
  }

  return (
    <div className="flex flex-col gap-6">
      {cards ? (
        <SectionCards cadence={badgeCopy.cadence} cardNote={badgeCopy.cardNote} cards={cards} />
      ) : null}
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-2">
          <div className="@3xl/main:hidden">
            <Select value={filter} onValueChange={choose}>
              <SelectTrigger className="h-8 w-40" aria-label="Show">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FILTERS.map(([key, label]) => (
                  <SelectItem key={key} value={key}>
                    {label} ({counts[key]})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Tabs value={filter} onValueChange={choose} className="hidden @3xl/main:flex">
            <TabsList>
              {FILTERS.map(([key, label]) => (
                <TabsTrigger key={key} value={key}>
                  {label}{' '}
                  <span className="inline-flex size-5 items-center justify-center rounded-full bg-muted-foreground/30 px-1 text-xs font-medium text-foreground">
                    {counts[key]}
                  </span>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <div className="flex items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="hidden @xl/main:flex">
                  <Columns3 />
                  Columns
                  <ChevronDown />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                {table
                  .getAllColumns()
                  .filter(column => column.getCanHide())
                  .map(column => (
                    <DropdownMenuCheckboxItem
                      key={column.id}
                      checked={column.getIsVisible()}
                      onCheckedChange={value => column.toggleVisibility(Boolean(value))}
                    >
                      {COLUMN_LABELS[column.id] ?? column.id}
                    </DropdownMenuCheckboxItem>
                  ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button asChild variant="outline" size="sm">
              <Link href={submitHref}>
                <Plus />
                Submit a product
              </Link>
            </Button>
          </div>
        </div>
        <DataTableView table={table} emptyLabel="Nothing here." />
        <PaginationFooter
          onPage={page => table.setPageIndex(page - 1)}
          onPageSize={size => table.setPageSize(size)}
          page={pagination.pageIndex + 1}
          pageCount={table.getPageCount()}
          pageSize={pagination.pageSize}
          summary={`${filtered.length} ${noun}`}
        />
        <StatusLegend legend={legend} />
      </div>
      <BadgeDrawer
        copy={badgeCopy}
        onOpenChange={open => {
          if (!open) closeBadge()
        }}
        row={badgeRow}
        siteName={siteName}
      />
      {withdrawing ? (
        <WithdrawDialog
          inQueue={withdrawing.status === 'in_review' || withdrawing.status === 'changes'}
          name={withdrawing.name}
          onOpenChange={open => {
            if (!open) setWithdrawing(null)
          }}
          open
          submissionId={withdrawing.id}
        />
      ) : null}
    </div>
  )
}

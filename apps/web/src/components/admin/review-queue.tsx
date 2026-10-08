'use client'

import {
  type ColumnDef,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  type SortingState,
  useReactTable
} from '@tanstack/react-table'
import { ArrowUpDown, Copy, EllipsisVertical, ExternalLink, Inbox, Pencil, X } from 'lucide-react'
import { usePathname, useRouter } from 'next/navigation'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { DataTableView, FacetFilter, PaginationFooter } from './data-table'
import { ageLabel, formatUsd, listingPath } from './format'
import { ProductCell } from './product-cell'
import { PlanBadge, StatusBadge, type StatusKind } from './status-badge'

/**
 * The review queue (#64 screen 10): status tabs, a name or domain filter, faceted Source, Plan,
 * and Badge filters, a table sorted by age (oldest first), and the pagination footer. Rows come
 * from the server per tab; filtering, sorting, and paging happen here.
 */

export interface QueueRow {
  badge: 'fail' | 'pass' | null
  href: string
  id: string
  kind: 'revision' | 'submission'
  listingSlug: string | null
  /** The hosted copy, or null for the fallback tile (#96 review S9). */
  logoUrl: string | null
  name: string
  ownerEmail: string | null
  paid: boolean
  paidAmountCents: number | null
  queuedAt: string | null
  slug: string
  status: string
  website: string
}

type View = 'all' | 'changes' | 'waiting'

function statusOf(row: QueueRow): { kind: StatusKind; label?: string } {
  if (row.kind === 'revision') {
    if (row.status === 'pending_review') return { kind: 'revision' }
    if (row.status === 'changes_requested') return { kind: 'changes' }
    if (row.status === 'approved') return { kind: 'approved' }
    if (row.status === 'rejected') return { kind: 'rejected' }
    return { kind: 'withdrawn' }
  }
  switch (row.status) {
    case 'verified':
      return row.paid ? { kind: 'paid_wait', label: 'Checks failed' } : { kind: 'in_review' }
    case 'paid_pending_review':
      return { kind: 'live_paid' }
    case 'changes_requested':
      return { kind: 'changes' }
    case 'approved':
      return { kind: 'approved' }
    case 'rejected':
      return { kind: 'rejected' }
    case 'pending_badge':
      return { kind: 'pending_badge' }
    default:
      return { kind: 'withdrawn' }
  }
}

function badgeOf(row: QueueRow): 'fail' | 'none' | 'optional' | 'pass' {
  if (row.paid) return 'optional'
  return row.badge ?? 'none'
}

const sourceOptions = [
  { label: 'Submission', value: 'submission' },
  { label: 'Revision', value: 'revision' }
]
const planOptions = [
  { label: 'Free', value: 'free' },
  { label: 'Paid', value: 'paid' }
]
const badgeOptions = [
  { label: 'Pass', value: 'pass' },
  { label: 'Fail', value: 'fail' },
  { label: 'Optional', value: 'optional' },
  { label: 'None', value: 'none' }
]

function RowMenu({ row }: { row: QueueRow }) {
  const router = useRouter()
  const publicUrl = `https://best.serp.co${listingPath(row.slug)}`
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="size-8 text-muted-foreground">
          <EllipsisVertical />
          <span className="sr-only">Open menu</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem onSelect={() => router.push(row.href)}>
          <Pencil />
          Open
        </DropdownMenuItem>
        {row.listingSlug ? (
          <DropdownMenuItem asChild>
            <a href={listingPath(row.listingSlug)} target="_blank" rel="noreferrer">
              <ExternalLink />
              View live
            </a>
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem
          onSelect={() =>
            void navigator.clipboard
              ?.writeText(publicUrl)
              .then(() => toast.success('URL copied'))
              .catch(() => toast.error('Could not copy the URL'))
          }
        >
          <Copy />
          Copy URL
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function ReviewQueue({
  counts,
  initialFilters,
  rows,
  view
}: {
  counts: { changes: number; waiting: number }
  initialFilters: { badge: string[]; plan: string[]; source: string[] }
  rows: QueueRow[]
  view: View
}) {
  const router = useRouter()
  const pathname = usePathname()
  const [query, setQuery] = useState('')
  const [source, setSource] = useState(initialFilters.source)
  const [plan, setPlan] = useState(initialFilters.plan)
  const [badge, setBadge] = useState(initialFilters.badge)
  const [sorting, setSorting] = useState<SortingState>([{ desc: view === 'all', id: 'age' }])
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 10 })

  const filtered = useMemo(() => {
    const text = query.trim().toLowerCase()
    return rows.filter(
      row =>
        (!text ||
          row.name.toLowerCase().includes(text) ||
          row.slug.includes(text) ||
          row.website.toLowerCase().includes(text)) &&
        (source.length === 0 || source.includes(row.kind)) &&
        (plan.length === 0 || plan.includes(row.paid ? 'paid' : 'free')) &&
        (badge.length === 0 || badge.includes(badgeOf(row)))
    )
  }, [badge, plan, query, rows, source])

  const columns = useMemo<ColumnDef<QueueRow>[]>(
    () => [
      {
        cell: ({ row }) => (
          <ProductCell
            href={row.original.href}
            logoUrl={row.original.logoUrl}
            name={row.original.name}
            sub={
              row.original.kind === 'revision' && row.original.ownerEmail
                ? `Owner ${row.original.ownerEmail}`
                : row.original.slug
            }
            website={row.original.website}
          />
        ),
        header: 'Product',
        id: 'product'
      },
      {
        accessorFn: row => (row.queuedAt ? Date.parse(row.queuedAt) : 0),
        cell: ({ row }) => <span className="tabular-nums">{ageLabel(row.original.queuedAt)}</span>,
        // Age grows as the time shrinks, so "oldest first" is the time ascending.
        header: ({ column }) => (
          <Button
            variant="ghost"
            size="sm"
            className="-ml-2 h-8 gap-1.5 px-2 font-medium"
            onClick={() => column.toggleSorting(column.getIsSorted() === 'asc')}
          >
            Age
            <ArrowUpDown className="size-3.5 text-muted-foreground" />
          </Button>
        ),
        id: 'age'
      },
      {
        cell: ({ row }) => (row.original.kind === 'revision' ? 'Revision' : 'Submission'),
        header: 'Source',
        id: 'source'
      },
      {
        cell: ({ row }) => <PlanBadge paid={row.original.paid} />,
        header: 'Plan',
        id: 'plan'
      },
      {
        cell: ({ row }) => {
          const value = badgeOf(row.original)
          if (value === 'optional') return <StatusBadge kind="na" label="Optional" />
          if (value === 'pass') return <StatusBadge kind="pass" />
          if (value === 'fail') return <StatusBadge kind="fail" />
          return <span className="text-muted-foreground">—</span>
        },
        header: 'Badge',
        id: 'badge'
      },
      {
        cell: ({ row }) => (
          <span className="tabular-nums text-muted-foreground">
            {row.original.paidAmountCents !== null ? formatUsd(row.original.paidAmountCents) : '—'}
          </span>
        ),
        header: 'Paid',
        id: 'paid'
      },
      {
        cell: ({ row }) => {
          const status = statusOf(row.original)
          return <StatusBadge kind={status.kind} label={status.label} />
        },
        header: 'Status',
        id: 'status'
      },
      {
        cell: ({ row }) => (
          <div className="flex justify-end">
            <RowMenu row={row.original} />
          </div>
        ),
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
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getRowId: row => `${row.kind}:${row.id}`,
    getSortedRowModel: getSortedRowModel(),
    onPaginationChange: setPagination,
    onSortingChange: setSorting,
    state: { pagination, sorting }
  })

  const filtering = query !== '' || source.length > 0 || plan.length > 0 || badge.length > 0
  const reset = () => {
    setQuery('')
    setSource([])
    setPlan([])
    setBadge([])
  }
  const goTo = (next: string) => {
    router.push(next === 'waiting' ? pathname : `${pathname}?view=${next}`)
  }
  const label = view === 'waiting' ? 'waiting' : view === 'changes' ? 'changes requested' : 'items'

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <Tabs value={view} onValueChange={goTo}>
          <TabsList>
            <TabsTrigger value="waiting">
              Waiting{' '}
              <span className="inline-flex size-5 items-center justify-center rounded-full bg-muted-foreground/30 px-1 text-xs font-medium text-foreground">
                {counts.waiting}
              </span>
            </TabsTrigger>
            <TabsTrigger value="changes">
              Changes requested{' '}
              <span className="inline-flex size-5 items-center justify-center rounded-full bg-muted-foreground/30 px-1 text-xs font-medium text-foreground">
                {counts.changes}
              </span>
            </TabsTrigger>
            <TabsTrigger value="all">All</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            aria-label="Filter by name or domain"
            className="h-8 w-full sm:w-[180px] lg:w-[250px]"
            onChange={event => {
              setQuery(event.target.value)
              setPagination(current => ({ ...current, pageIndex: 0 }))
            }}
            placeholder="Filter by name or domain…"
            value={query}
          />
          <FacetFilter
            onChange={setSource}
            options={sourceOptions}
            selected={source}
            title="Source"
          />
          <FacetFilter
            onChange={setPlan}
            options={planOptions.map(option => ({
              ...option,
              count: rows.filter(row => (row.paid ? 'paid' : 'free') === option.value).length
            }))}
            selected={plan}
            title="Plan"
          />
          <FacetFilter onChange={setBadge} options={badgeOptions} selected={badge} title="Badge" />
          {filtering ? (
            <Button variant="ghost" size="sm" onClick={reset}>
              Reset
              <X />
            </Button>
          ) : null}
        </div>
      </div>
      {rows.length === 0 && view === 'waiting' ? (
        <Card>
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Inbox />
              </EmptyMedia>
              <EmptyTitle>Queue is clear</EmptyTitle>
              <EmptyDescription>
                New submissions show up here once their badge is verified or their payment goes
                through. Revisions to live listings show up too.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </Card>
      ) : (
        <>
          <DataTableView table={table} />
          <PaginationFooter
            onPage={page => table.setPageIndex(page - 1)}
            onPageSize={size => table.setPageSize(size)}
            page={pagination.pageIndex + 1}
            pageCount={table.getPageCount()}
            pageSize={pagination.pageSize}
            summary={`${filtered.length} of ${rows.length} ${label}`}
          />
        </>
      )}
    </div>
  )
}

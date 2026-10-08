'use client'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { type ColumnDef, getCoreRowModel, useReactTable } from '@tanstack/react-table'
import { Copy, EllipsisVertical, ExternalLink, EyeOff, Pencil, Users, X } from 'lucide-react'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { DataTableView, FacetFilter, PaginationFooter } from './data-table'
import { formatShortDate, listingPath } from './format'
import { ProductCell } from './product-cell'
import { StatusBadge, type StatusKind } from './status-badge'

/**
 * The listing search (#64 screen 12): a name or domain filter and faceted Status, Source, and
 * Link filters, all in the URL and applied by D1 (`selectAdminListingsPlans`), one page at a
 * time.
 */

export interface ListingRowView {
  adminStatus: 'blocked' | 'draft' | 'live' | 'rejected' | 'unlisted'
  id: string
  linkRel: string
  logoUrl: string | null
  name: string
  ownerEmail: string | null
  planLabel: string
  slug: string
  sourceLabel: string
  updatedAt: string | null
  website: string
}

export interface ListingFilters {
  link: string[]
  page: number
  q: string
  size: number
  source: string[]
  status: string[]
}

const statusKinds: Record<ListingRowView['adminStatus'], { kind: StatusKind; label?: string }> = {
  blocked: { kind: 'blocked' },
  draft: { kind: 'draft' },
  live: { kind: 'live' },
  rejected: { kind: 'rejected' },
  unlisted: { kind: 'unlisted' }
}

function RowMenu({ row }: { row: ListingRowView }) {
  const router = useRouter()
  const detail = `/admin/listings/${encodeURIComponent(row.slug)}/`
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="size-8 text-muted-foreground">
          <EllipsisVertical />
          <span className="sr-only">Open menu</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem onSelect={() => router.push(detail)}>
          <Pencil />
          Open
        </DropdownMenuItem>
        {row.adminStatus === 'live' ? (
          <DropdownMenuItem asChild>
            <a href={listingPath(row.slug)} target="_blank" rel="noreferrer">
              <ExternalLink />
              View live
            </a>
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem
          onSelect={() =>
            void navigator.clipboard
              ?.writeText(`https://best.serp.co${listingPath(row.slug)}`)
              .then(() => toast.success('URL copied'))
              .catch(() => toast.error('Could not copy the URL'))
          }
        >
          <Copy />
          Copy URL
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => router.push(`${detail}?dialog=transfer`)}>
          <Users />
          Transfer owner…
        </DropdownMenuItem>
        {row.adminStatus === 'live' ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive focus:text-destructive [&_svg]:!text-destructive"
              onSelect={() => router.push(`${detail}?dialog=unpublish`)}
            >
              <EyeOff />
              Unpublish…
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function ListingSearch({
  facets,
  filters,
  matches,
  rows,
  total
}: {
  facets: Record<'link' | 'source' | 'status', Record<string, number>>
  filters: ListingFilters
  matches: number
  rows: ListingRowView[]
  total: number
}) {
  const router = useRouter()
  const pathname = usePathname()
  const [query, setQuery] = useState(filters.q)
  const first = useRef(true)

  const navigate = (next: Partial<ListingFilters>) => {
    const merged = { ...filters, page: 1, ...next }
    const params = new URLSearchParams()
    if (merged.q) params.set('q', merged.q)
    if (merged.status.length) params.set('status', merged.status.join(','))
    if (merged.source.length) params.set('source', merged.source.join(','))
    if (merged.link.length) params.set('link', merged.link.join(','))
    if (merged.page > 1) params.set('page', String(merged.page))
    if (merged.size !== 10) params.set('size', String(merged.size))
    const search = params.toString()
    router.replace(search ? `${pathname}?${search}` : pathname)
  }

  // The text filter applies after a short pause.
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    const timer = setTimeout(() => {
      if (query.trim() !== filters.q) navigate({ q: query.trim() })
    }, 300)
    return () => clearTimeout(timer)
  }, [query])

  const columns = useMemo<ColumnDef<ListingRowView>[]>(
    () => [
      {
        cell: ({ row }) => (
          <ProductCell
            href={`/admin/listings/${encodeURIComponent(row.original.slug)}/`}
            logoUrl={row.original.logoUrl}
            name={row.original.name}
            sub={row.original.slug}
            website={row.original.website}
          />
        ),
        header: 'Product',
        id: 'product'
      },
      {
        cell: ({ row }) => {
          const status = statusKinds[row.original.adminStatus]
          return <StatusBadge kind={status.kind} label={status.label} />
        },
        header: 'Status',
        id: 'status'
      },
      { accessorKey: 'sourceLabel', header: 'Source' },
      {
        cell: ({ row }) =>
          row.original.ownerEmail ?? <span className="text-muted-foreground">None</span>,
        header: 'Owner',
        id: 'owner'
      },
      { accessorKey: 'planLabel', header: 'Plan' },
      {
        cell: ({ row }) => <code className="font-mono text-[13px]">{row.original.linkRel}</code>,
        header: 'Link',
        id: 'link'
      },
      {
        cell: ({ row }) => (
          <span className="text-muted-foreground">{formatShortDate(row.original.updatedAt)}</span>
        ),
        header: 'Updated',
        id: 'updated'
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
    data: rows,
    getCoreRowModel: getCoreRowModel(),
    getRowId: row => row.id,
    manualPagination: true
  })

  const filtering =
    filters.q !== '' ||
    filters.status.length > 0 ||
    filters.source.length > 0 ||
    filters.link.length > 0
  const count = (facet: keyof typeof facets, value: string) => facets[facet][value] ?? 0
  const summary = filters.q
    ? `${matches.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} listings match “${filters.q}”`
    : filtering
      ? `${matches.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} listings`
      : `${total.toLocaleString('en-US')} listings`

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label="Filter by name or domain"
          className="h-8 w-full sm:w-[180px] lg:w-[250px]"
          onChange={event => setQuery(event.target.value)}
          placeholder="Filter by name or domain…"
          value={query}
        />
        <FacetFilter
          onChange={status => navigate({ status })}
          options={[
            { count: count('status', 'live'), label: 'Live', value: 'live' },
            { count: count('status', 'unlisted'), label: 'Unlisted', value: 'unlisted' },
            { count: count('status', 'rejected'), label: 'Rejected', value: 'rejected' },
            { count: count('status', 'blocked'), label: 'Rejected: prohibited', value: 'blocked' }
          ]}
          selected={filters.status}
          title="Status"
        />
        <FacetFilter
          onChange={source => navigate({ source })}
          options={[
            { count: count('source', 'admin'), label: 'Admin', value: 'admin' },
            { count: count('source', 'submission'), label: 'Submission', value: 'submission' }
          ]}
          selected={filters.source}
          title="Source"
        />
        <FacetFilter
          onChange={link => navigate({ link })}
          options={[
            { count: count('link', 'follow'), label: 'follow', value: 'follow' },
            { count: count('link', 'nofollow'), label: 'nofollow', value: 'nofollow' },
            { count: count('link', 'sponsored'), label: 'sponsored', value: 'sponsored' }
          ]}
          selected={filters.link}
          title="Link"
        />
        {filtering ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setQuery('')
              navigate({ link: [], q: '', source: [], status: [] })
            }}
          >
            Reset
            <X />
          </Button>
        ) : null}
      </div>
      <DataTableView table={table} />
      <PaginationFooter
        onPage={page => navigate({ page })}
        onPageSize={size => navigate({ size })}
        page={filters.page}
        pageCount={Math.ceil(matches / filters.size)}
        pageSize={filters.size}
        summary={summary}
      />
    </div>
  )
}

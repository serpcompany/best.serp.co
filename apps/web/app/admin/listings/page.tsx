import { DashboardPageHeader } from '@serpdirectory/web-core/dashboard/page-header'
import type { Metadata } from 'next'
import { AdminCrumbs } from '@/components/admin/admin-shell'
import { type ListingFilters, ListingSearch } from '@/components/admin/listing-search'
import { planLabel, sourceLabel } from '@/lib/admin/listing-labels'
import { getAdminReads } from '@/lib/admin/runtime'
import { requireAdmin } from '@/lib/auth/server'

/** Listings (#64 screen 12): search, facets, and one page of results from D1. */
export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Listings' }

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

function one(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? ''
}

function list(value: string | string[] | undefined, allowed: readonly string[]): string[] {
  return one(value)
    .split(',')
    .map(item => item.trim().toLowerCase())
    .filter(item => allowed.includes(item))
}

function positive(value: string | string[] | undefined, fallback: number, max: number): number {
  const number = Number.parseInt(one(value), 10)
  return Number.isSafeInteger(number) && number >= 1 ? Math.min(number, max) : fallback
}

export default async function ListingsPage({ searchParams }: Props) {
  await requireAdmin()
  const params = await searchParams
  const size = [10, 20, 50].includes(positive(params.size, 10, 50))
    ? positive(params.size, 10, 50)
    : 10
  const filters: ListingFilters = {
    link: list(params.link, ['follow', 'nofollow', 'sponsored']),
    page: positive(params.page, 1, 10_000),
    q: one(params.q).trim().slice(0, 100),
    size,
    source: list(params.source, ['admin', 'submission']),
    status: list(params.status, ['live', 'unlisted', 'rejected', 'blocked'])
  }
  const result = await (await getAdminReads()).searchListings(
    { linkRels: filters.link, query: filters.q, sources: filters.source, statuses: filters.status },
    { limit: filters.size, offset: (filters.page - 1) * filters.size }
  )
  return (
    <>
      <AdminCrumbs crumbs={[{ href: '/admin/', label: 'Admin' }, { label: 'Listings' }]} />

      <DashboardPageHeader
        title="Listings"
        description={`${result.total.toLocaleString('en-US')} listings`}
      />
      <ListingSearch
        facets={result.facets}
        filters={filters}
        matches={result.matches}
        rows={result.rows.map(row => ({
          adminStatus: row.adminStatus,
          id: row.id,
          linkRel: row.linkRel,
          logoUrl: row.logoUrl,
          name: row.name,
          ownerEmail: row.ownerEmail,
          planLabel: planLabel(row),
          slug: row.slug,
          sourceLabel: sourceLabel(row),
          updatedAt: row.updatedAt,
          website: row.website
        }))}
        total={result.total}
      />
    </>
  )
}

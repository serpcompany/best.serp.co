import type { Metadata } from 'next'
import Link from 'next/link'
import { AdminCrumbs } from '@/components/admin/admin-shell'
import { DashboardPageHeader } from '@/components/dashboard/page-header'
import { buttonVariants } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table'
import { getAdminReads } from '@/lib/admin/runtime'
import { countLabel, groupSuggestions } from '@/lib/admin/taxonomy-view'
import { requireAdmin } from '@/lib/auth/server'

/**
 * Category suggestions (#406): what submitters and owners suggest on submissions and revisions
 * still on their way to a decision, grouped by name so repeats show, each linking its reviews
 * and opening the tag or category form with the name filled in.
 */
export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Category suggestions' }

export default async function SuggestionsPage() {
  await requireAdmin()
  const rows = await (await getAdminReads()).listCategorySuggestions()
  const groups = groupSuggestions(rows)
  return (
    <>
      <AdminCrumbs
        crumbs={[{ href: '/admin/', label: 'Admin' }, { label: 'Category suggestions' }]}
      />

      <DashboardPageHeader
        title="Category suggestions"
        description={countLabel(rows.length, 'open suggestion', 'open suggestions')}
      />
      <div className="overflow-hidden rounded-lg border">
        <Table>
          <TableHeader className="bg-muted">
            <TableRow>
              <TableHead className="text-foreground first:pl-4">Suggestion</TableHead>
              <TableHead className="text-foreground">Times</TableHead>
              <TableHead className="text-foreground">In review</TableHead>
              <TableHead className="text-right text-foreground last:pr-4">
                <span className="sr-only">Create</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {groups.length ? (
              groups.map(group => (
                <TableRow key={group.key} className="align-top">
                  <TableCell className="font-medium first:pl-4">{group.name}</TableCell>
                  <TableCell className="tabular-nums">{group.count}</TableCell>
                  <TableCell className="whitespace-normal">
                    <ul className="flex flex-col gap-2">
                      {group.records.map(record => (
                        <li key={record.href} className="flex flex-col">
                          <Link className="font-medium hover:underline" href={record.href}>
                            {record.listingName}
                          </Link>
                          <span className="text-muted-foreground">
                            {[record.categoryName, record.note].filter(Boolean).join(' · ')}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </TableCell>
                  <TableCell className="last:pr-4">
                    <div className="flex justify-end gap-2">
                      <Link
                        className={buttonVariants({ variant: 'outline', size: 'sm' })}
                        href={`/admin/tags/?name=${encodeURIComponent(group.name)}`}
                      >
                        Create tag
                      </Link>
                      <Link
                        className={buttonVariants({ variant: 'outline', size: 'sm' })}
                        href={`/admin/categories/?name=${encodeURIComponent(group.name)}`}
                      >
                        Create category
                      </Link>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={4} className="h-24 text-center">
                  No results.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </>
  )
}

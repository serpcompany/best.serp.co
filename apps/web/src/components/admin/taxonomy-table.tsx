import Link from 'next/link'
import type { ReactNode } from 'react'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table'

/**
 * The taxonomy screens' lists (#405): the admin allowlist's bordered table with a muted header,
 * each row's first cell linking to its edit page.
 */

export interface TaxonomyRow {
  cells: ReactNode[]
  href: string
  key: string
  name: string
}

export function TaxonomyTable({
  columns,
  nameLabel = 'Name',
  rows
}: {
  /** The column headings after the first, the linked name. */
  columns: string[]
  nameLabel?: string
  rows: TaxonomyRow[]
}) {
  return (
    <div className="overflow-hidden rounded-lg border">
      <Table>
        <TableHeader className="bg-muted">
          <TableRow>
            {[nameLabel, ...columns].map(column => (
              <TableHead key={column} className="text-foreground first:pl-4 last:pr-4">
                {column}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length ? (
            rows.map(row => (
              <TableRow key={row.key}>
                <TableCell className="first:pl-4">
                  <Link className="font-medium hover:underline" href={row.href}>
                    {row.name}
                  </Link>
                </TableCell>
                {row.cells.map((cell, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: cells are positional columns
                  <TableCell key={index} className="text-muted-foreground last:pr-4">
                    {cell}
                  </TableCell>
                ))}
              </TableRow>
            ))
          ) : (
            <TableRow>
              <TableCell colSpan={columns.length + 1} className="h-24 text-center">
                No results.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  )
}

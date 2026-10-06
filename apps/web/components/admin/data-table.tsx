'use client'

import { Badge } from '@serpdirectory/design-system/badge'
import { Button } from '@serpdirectory/design-system/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator
} from '@serpdirectory/design-system/command'
import { cn } from '@serpdirectory/design-system/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '@serpdirectory/design-system/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@serpdirectory/design-system/select'
import { Separator } from '@serpdirectory/design-system/separator'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@serpdirectory/design-system/table'
import { flexRender, type Table as TanstackTable } from '@tanstack/react-table'
import {
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  PlusCircle
} from 'lucide-react'
import type { ReactNode } from 'react'

/**
 * The data-table pieces of the #70 admin mockups (shadcn data-table and dashboard-01): a
 * bordered table with a muted header, faceted filters (a dashed outline button with a
 * popover command list), and the pagination footer.
 */

export function DataTableView<T>({
  className,
  emptyLabel = 'No results.',
  table
}: {
  className?: string
  emptyLabel?: string
  table: TanstackTable<T>
}) {
  const columns = table.getAllLeafColumns().length
  return (
    <div className={cn('overflow-hidden rounded-lg border', className)}>
      <Table>
        <TableHeader className="bg-muted">
          {table.getHeaderGroups().map(group => (
            <TableRow key={group.id}>
              {group.headers.map(header => (
                <TableHead
                  key={header.id}
                  className="whitespace-nowrap text-foreground first:pl-4 last:pr-4"
                >
                  {header.isPlaceholder
                    ? null
                    : flexRender(header.column.columnDef.header, header.getContext())}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.length ? (
            table.getRowModel().rows.map(row => (
              <TableRow key={row.id}>
                {row.getVisibleCells().map(cell => (
                  <TableCell key={cell.id} className="whitespace-nowrap first:pl-4 last:pr-4">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))
          ) : (
            <TableRow>
              <TableCell colSpan={columns} className="h-24 text-center text-muted-foreground">
                {emptyLabel}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  )
}

export interface FacetOption {
  count?: number
  label: string
  value: string
}

/** A faceted filter: dashed outline button, popover with a command list of checkable options. */
export function FacetFilter({
  onChange,
  options,
  selected,
  title
}: {
  onChange: (values: string[]) => void
  options: FacetOption[]
  selected: string[]
  title: string
}) {
  const toggle = (value: string) =>
    onChange(
      selected.includes(value) ? selected.filter(item => item !== value) : [...selected, value]
    )
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 border-dashed">
          <PlusCircle />
          {title}
          {selected.length > 0 ? (
            <>
              <Separator orientation="vertical" className="mx-1 h-4" />
              {selected.length > 2 ? (
                <Badge variant="secondary" className="rounded-sm px-1 font-normal">
                  {selected.length} selected
                </Badge>
              ) : (
                options
                  .filter(option => selected.includes(option.value))
                  .map(option => (
                    <Badge
                      key={option.value}
                      variant="secondary"
                      className="rounded-sm px-1 font-normal"
                    >
                      {option.label}
                    </Badge>
                  ))
              )}
            </>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[200px] p-0" align="start">
        <Command>
          <CommandInput placeholder={title} />
          <CommandList>
            <CommandEmpty>No results found.</CommandEmpty>
            <CommandGroup>
              {options.map(option => {
                const isSelected = selected.includes(option.value)
                return (
                  <CommandItem key={option.value} onSelect={() => toggle(option.value)}>
                    <div
                      className={cn(
                        'flex size-4 items-center justify-center rounded-[4px] border',
                        isSelected
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-input [&_svg]:invisible'
                      )}
                    >
                      <Check className="size-3.5 text-primary-foreground" />
                    </div>
                    <span>{option.label}</span>
                    {option.count !== undefined ? (
                      <span className="ml-auto flex size-4 items-center justify-center font-mono text-xs">
                        {option.count}
                      </span>
                    ) : null}
                  </CommandItem>
                )
              })}
            </CommandGroup>
            {selected.length > 0 ? (
              <>
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem onSelect={() => onChange([])} className="justify-center text-center">
                    Clear filters
                  </CommandItem>
                </CommandGroup>
              </>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/** The footer: a summary on the left, rows per page, "Page N of M", and page buttons. */
export function PaginationFooter({
  onPage,
  onPageSize,
  page,
  pageCount,
  pageSize,
  summary
}: {
  onPage: (page: number) => void
  onPageSize: (size: number) => void
  /** 1-based. */
  page: number
  pageCount: number
  pageSize: number
  summary: ReactNode
}) {
  const pages = Math.max(1, pageCount)
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="hidden flex-1 text-sm text-muted-foreground md:flex">{summary}</div>
      <div className="flex w-full items-center gap-6 md:w-fit">
        <div className="hidden items-center gap-2 lg:flex">
          <span className="whitespace-nowrap text-sm font-medium">Rows per page</span>
          <Select value={String(pageSize)} onValueChange={value => onPageSize(Number(value))}>
            <SelectTrigger className="h-8 w-20" aria-label="Rows per page">
              <SelectValue />
            </SelectTrigger>
            <SelectContent side="top">
              {[10, 20, 50].map(size => (
                <SelectItem key={size} value={String(size)}>
                  {size}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex w-fit items-center justify-center text-sm font-medium">
          Page {Math.min(page, pages)} of {pages}
        </div>
        <div className="ml-auto flex items-center gap-2 md:ml-0">
          <Button
            variant="outline"
            size="icon"
            className="hidden size-8 lg:flex"
            disabled={page <= 1}
            onClick={() => onPage(1)}
          >
            <span className="sr-only">First page</span>
            <ChevronsLeft />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            disabled={page <= 1}
            onClick={() => onPage(page - 1)}
          >
            <span className="sr-only">Previous page</span>
            <ChevronLeft />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            disabled={page >= pages}
            onClick={() => onPage(page + 1)}
          >
            <span className="sr-only">Next page</span>
            <ChevronRight />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="hidden size-8 lg:flex"
            disabled={page >= pages}
            onClick={() => onPage(pages)}
          >
            <span className="sr-only">Last page</span>
            <ChevronsRight />
          </Button>
        </div>
      </div>
    </div>
  )
}

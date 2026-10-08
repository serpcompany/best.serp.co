import type { ReactNode } from 'react'
import { ProductLogo } from '@/components/submit/submit-ui'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { HistoryItem } from '@/lib/account/history'
import { cn } from '@/lib/utils'

/**
 * Pieces of the account's detail pages (#70 screens 6 and 7): the heading row (logo, name with
 * its status chips, a meta line, and the actions), label and value rows, the two-column body,
 * and the history timeline.
 */

export function AccountRecordHeader({
  actions,
  chips,
  logoUrl,
  meta,
  name,
  title
}: {
  actions?: ReactNode
  chips?: ReactNode
  logoUrl: string | null
  meta: ReactNode
  name: string
  /** The heading; the product's name unless given ("Edit Ledgerly"). */
  title?: string
}) {
  return (
    <div className="flex flex-col gap-4 @3xl/main:flex-row @3xl/main:items-start @3xl/main:justify-between">
      <div className="flex min-w-0 items-start gap-3 @3xl/main:flex-1">
        <ProductLogo name={name} size={48} src={logoUrl} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="min-w-0 max-w-full truncate text-2xl font-semibold tracking-tight">
              {title ?? name}
            </h1>
            {chips}
          </div>
          <p className="mt-1 break-words text-sm text-muted-foreground">{meta}</p>
        </div>
      </div>
      {actions ? (
        <div className="flex flex-wrap gap-2 @3xl/main:shrink-0 @3xl/main:flex-nowrap">
          {actions}
        </div>
      ) : null}
    </div>
  )
}

/** Label and value rows in two columns, as the mockups' read-only cards show them. */
export function Kv({ rows }: { rows: ReadonlyArray<[string, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-3 text-sm">
      {rows.map(([key, value]) => (
        <div key={key} className="contents">
          <dt className="text-muted-foreground">{key}</dt>
          <dd className="min-w-0 break-words font-medium">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** The main column and a 260 px aside, side by side from the container's lg width. */
export function TwoColumns({ aside, children }: { aside: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-6 @3xl/main:grid-cols-[minmax(0,1fr)_260px]">
      <div className="flex min-w-0 flex-col gap-6">{children}</div>
      <div className="flex flex-col gap-6">{aside}</div>
    </div>
  )
}

const DOT: Record<HistoryItem['tone'], string> = {
  err: 'bg-destructive',
  muted: 'bg-muted-foreground/40',
  now: 'bg-info ring-4 ring-info/20',
  ok: 'bg-success',
  warn: 'bg-warning'
}

export function HistoryCard({ items }: { items: readonly HistoryItem[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>History</CardTitle>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing yet.</p>
        ) : (
          <ol className="space-y-4">
            {items.map(item => (
              <li key={item.key} className="flex gap-3">
                <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', DOT[item.tone])} />
                <div className="text-sm">
                  <p className="font-medium">{item.title}</p>
                  <p className="text-xs text-muted-foreground">{item.detail}</p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  )
}

import type { ReactNode } from 'react'

/**
 * Label and value rows in two columns, keys beside their values, as in the mockups' cards
 * (#70 screens 11 and 12; #64 review). Long values (URLs, domains) wrap inside their column.
 */
export function Kv({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-3 text-sm">
      {rows.map(([key, value]) => (
        <div key={key} className="contents">
          <dt className="text-muted-foreground">{key}</dt>
          <dd className="min-w-0 break-words font-medium">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

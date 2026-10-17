import type { TimelineItem } from '@/lib/admin/listing-view'
import { cn } from '@/lib/utils'

/**
 * A dated list of rows with a status dot: the listing page's activity, and the submission
 * page's decision emails (#490).
 */
export function Timeline({ items }: { items: readonly TimelineItem[] }) {
  if (items.length === 0) return <p className="text-sm text-muted-foreground">No activity yet.</p>
  return (
    <ol className="space-y-4">
      {items.map(item => (
        <li key={item.key} className="flex gap-3">
          <span
            className={cn(
              'mt-1.5 size-2 shrink-0 rounded-full',
              item.tone === 'ok'
                ? 'bg-success'
                : item.tone === 'warn'
                  ? 'bg-warning'
                  : item.tone === 'err'
                    ? 'bg-destructive'
                    : 'bg-muted-foreground/40'
            )}
          />
          <div className="text-sm">
            <p className="font-medium">{item.title}</p>
            <p className="text-xs text-muted-foreground">{item.detail}</p>
          </div>
        </li>
      ))}
    </ol>
  )
}

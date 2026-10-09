import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * The row of controls over a list (serplists' `Toolbar`, #257): side by side, stacked on
 * phones.
 */
export function Toolbar({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn('flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center', className)}
      data-slot="toolbar"
    >
      {children}
    </div>
  )
}

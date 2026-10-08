import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

/** A status's tone: one of the theme's status tokens (#184), or muted for a neutral state. */
export type StatusTone = 'destructive' | 'info' | 'muted' | 'success' | 'warning'

const ICON_TONE: Record<StatusTone, string> = {
  destructive: 'text-destructive',
  info: 'text-info',
  muted: 'text-muted-foreground',
  success: 'text-success',
  warning: 'text-warning'
}

/** A filled circle's tone: the token fills it, and its glyph takes the token's foreground. */
const FILLED_TONE: Record<StatusTone, string> = {
  destructive: 'fill-destructive text-destructive-foreground',
  info: 'fill-info text-info-foreground',
  muted: 'fill-muted-foreground text-background',
  success: 'fill-success text-success-foreground',
  warning: 'fill-warning text-warning-foreground'
}

/**
 * The one status chip, wherever a status appears (submissions, listings, orders, badge checks):
 * dashboard-01's outline Badge with a toned lucide icon, `filled` for live and final states.
 */
export function StatusChip({
  children,
  className,
  filled = false,
  icon: Icon,
  tone
}: {
  children: ReactNode
  className?: string
  filled?: boolean
  icon: LucideIcon
  tone: StatusTone
}) {
  return (
    <Badge variant="outline" className={cn('px-1.5 text-muted-foreground', className)}>
      <Icon aria-hidden="true" className={filled ? FILLED_TONE[tone] : ICON_TONE[tone]} />
      {children}
    </Badge>
  )
}

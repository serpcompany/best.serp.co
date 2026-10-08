import {
  Ban,
  CircleAlert,
  CircleCheck,
  CircleMinus,
  CircleX,
  Clock,
  EyeOff,
  Loader,
  type LucideIcon,
  MessageSquare,
  TriangleAlert,
  Undo2
} from 'lucide-react'
import { StatusChip, type StatusTone } from '@/components/status/status-chip'
import { Badge } from '@/components/ui/badge'

/**
 * Status chips from the #70 mockups: dashboard-01's pattern, an outline Badge with a toned
 * lucide icon (filled circles for final states). Each entry is its label, icon, tone, and fill.
 */
const STATUS = {
  approved: ['Approved', CircleCheck, 'success', true],
  blocked: ['Rejected: prohibited', Ban, 'destructive'],
  changes: ['Changes requested', MessageSquare, 'warning'],
  draft: ['Draft', CircleMinus, 'muted'],
  fail: ['Fail', CircleX, 'destructive', true],
  inconclusive: ['Inconclusive', CircleMinus, 'muted'],
  in_review: ['In review', Loader, 'info'],
  live: ['Live', CircleCheck, 'success', true],
  live_paid: ['Live (paid, in review)', CircleCheck, 'success', true],
  miss_warn: ['Missing, recheck pending', TriangleAlert, 'warning'],
  na: ['Not required', CircleMinus, 'muted'],
  not_paid: ['Not paid', CircleMinus, 'muted'],
  // Orders (#68, #70 screens 4 and 13).
  o_failed: ['Failed', CircleX, 'destructive', true],
  o_paid: ['Paid', CircleCheck, 'success', true],
  o_pending: ['Pending', Clock, 'warning'],
  o_refunded: ['Refunded', Undo2, 'muted'],
  o_refunding: ['Refunding', Undo2, 'warning'],
  paid_wait: ['Paid, waiting for review', Clock, 'warning'],
  pass: ['Pass', CircleCheck, 'success', true],
  pending_badge: ['Pending badge', Clock, 'warning'],
  rejected: ['Rejected', CircleX, 'destructive', true],
  revision: ['Revision in review', Loader, 'info'],
  unlisted: ['Unlisted', EyeOff, 'muted'],
  warn: ['Attention', CircleAlert, 'warning'],
  withdrawn: ['Withdrawn', Undo2, 'muted']
} satisfies Record<string, [string, LucideIcon, StatusTone, true?]>

export type StatusKind = keyof typeof STATUS

export function StatusBadge({
  className,
  kind,
  label
}: {
  className?: string
  kind: StatusKind
  label?: string
}) {
  const [text, icon, tone, filled] = STATUS[kind]
  return (
    <StatusChip className={className} filled={filled} icon={icon} tone={tone}>
      {label ?? text}
    </StatusChip>
  )
}

/** "Paid" (filled) or "Free" (outline). */
export function PlanBadge({ paid }: { paid: boolean }) {
  return <Badge variant={paid ? 'default' : 'outline'}>{paid ? 'Paid' : 'Free'}</Badge>
}

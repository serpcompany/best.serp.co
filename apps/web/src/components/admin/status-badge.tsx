import {
  Ban,
  CircleAlert,
  CircleCheck,
  CircleMinus,
  CircleX,
  Clock,
  EyeOff,
  Loader,
  MessageSquare,
  TriangleAlert,
  Undo2
} from 'lucide-react'
import type { ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

/**
 * Status badges from the #70 mockups: dashboard-01's pattern, an outline Badge with a colored
 * lucide icon (filled circles for final states).
 */
const STATUS = {
  approved: [
    'Approved',
    <CircleCheck key="i" className="fill-emerald-500 text-background dark:fill-emerald-400" />
  ],
  blocked: ['Rejected: prohibited', <Ban key="i" className="text-red-500" />],
  changes: ['Changes requested', <MessageSquare key="i" className="text-orange-500" />],
  draft: ['Draft', <CircleMinus key="i" className="text-muted-foreground" />],
  fail: ['Fail', <CircleX key="i" className="fill-red-500 text-background dark:fill-red-400" />],
  inconclusive: ['Inconclusive', <CircleMinus key="i" className="text-muted-foreground" />],
  in_review: ['In review', <Loader key="i" className="text-sky-500" />],
  live: [
    'Live',
    <CircleCheck key="i" className="fill-emerald-500 text-background dark:fill-emerald-400" />
  ],
  live_paid: [
    'Live (paid, in review)',
    <CircleCheck key="i" className="fill-teal-500 text-background dark:fill-teal-400" />
  ],
  miss_warn: ['Missing, recheck pending', <TriangleAlert key="i" className="text-amber-500" />],
  na: ['Not required', <CircleMinus key="i" className="text-muted-foreground" />],
  not_paid: ['Not paid', <CircleMinus key="i" className="text-muted-foreground" />],
  // Orders (#68, #70 screens 4 and 13).
  o_failed: [
    'Failed',
    <CircleX key="i" className="fill-red-500 text-background dark:fill-red-400" />
  ],
  o_paid: [
    'Paid',
    <CircleCheck key="i" className="fill-emerald-500 text-background dark:fill-emerald-400" />
  ],
  o_pending: ['Pending', <Clock key="i" className="text-amber-500" />],
  o_refunded: ['Refunded', <Undo2 key="i" className="text-muted-foreground" />],
  o_refunding: ['Refunding', <Undo2 key="i" className="text-amber-500" />],
  paid_wait: ['Paid, waiting for review', <Clock key="i" className="text-amber-500" />],
  pass: [
    'Pass',
    <CircleCheck key="i" className="fill-emerald-500 text-background dark:fill-emerald-400" />
  ],
  pending_badge: ['Pending badge', <Clock key="i" className="text-amber-500" />],
  rejected: [
    'Rejected',
    <CircleX key="i" className="fill-red-500 text-background dark:fill-red-400" />
  ],
  revision: ['Revision in review', <Loader key="i" className="text-sky-500" />],
  unlisted: ['Unlisted', <EyeOff key="i" className="text-muted-foreground" />],
  warn: ['Attention', <CircleAlert key="i" className="text-amber-500" />],
  withdrawn: ['Withdrawn', <Undo2 key="i" className="text-muted-foreground" />]
} satisfies Record<string, [string, ReactNode]>

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
  const [text, icon] = STATUS[kind]
  return (
    <Badge variant="outline" className={cn('px-1.5 text-muted-foreground', className)}>
      {icon}
      {label ?? text}
    </Badge>
  )
}

/** "Paid" (filled) or "Free" (outline). */
export function PlanBadge({ paid }: { paid: boolean }) {
  return <Badge variant={paid ? 'default' : 'outline'}>{paid ? 'Paid' : 'Free'}</Badge>
}

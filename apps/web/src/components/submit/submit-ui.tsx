'use client'

import {
  CircleAlert,
  CircleCheck,
  CircleX,
  Clock,
  Info,
  Loader,
  type LucideIcon,
  Pencil,
  TriangleAlert,
  Undo2
} from 'lucide-react'
import type { ReactNode } from 'react'
import { ListingImage } from '@/components/listing/listing-image'
import { StatusChip, type StatusTone } from '@/components/status/status-chip'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Progress } from '@/components/ui/progress'
import type { SubmissionStatusName } from '@/lib/submissions/contract'
import { cn } from '@/lib/utils'

/**
 * Building blocks shared by the submit pages (#70 screens 2, 2b, 3) and the account table:
 * the step progress, status badges, toned alerts, and the product logo.
 */

/** `Step 2 of 4` above a Progress bar (#70 StepProgress). */
export function StepProgress({
  label,
  step,
  total
}: {
  label: string
  step: number
  total: number
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium">{label}</span>
        <span className="text-muted-foreground">
          Step {step} of {total}
        </span>
      </div>
      <Progress
        value={Math.round((step / total) * 100)}
        aria-label={`${label}: step ${step} of ${total}`}
      />
    </div>
  )
}

export type AlertTone = 'default' | 'destructive' | 'info' | 'success' | 'warning'

const TONE_CLASSES: Record<AlertTone, string> = {
  default: 'bg-card text-card-foreground',
  destructive: '',
  info: 'border-info/40 bg-card text-info',
  success: 'border-success/40 bg-card text-success',
  warning: 'border-warning/40 bg-card text-warning'
}

const TONE_ICONS: Record<AlertTone, LucideIcon> = {
  default: Info,
  destructive: CircleX,
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert
}

/**
 * The mockups' Alert: `default` and `destructive` are stock shadcn variants; `warning`,
 * `success`, and `info` are className tones on the default variant.
 */
export function ToneAlert({
  actions,
  children,
  className,
  icon,
  title,
  tone = 'default'
}: {
  actions?: ReactNode
  children?: ReactNode
  className?: string
  icon?: LucideIcon
  title: ReactNode
  tone?: AlertTone
}) {
  const Icon = icon ?? TONE_ICONS[tone]
  return (
    <Alert
      variant={tone === 'destructive' ? 'destructive' : 'default'}
      className={cn(TONE_CLASSES[tone], className)}
    >
      <Icon aria-hidden="true" />
      <AlertTitle>{title}</AlertTitle>
      {children || actions ? (
        <AlertDescription className="[overflow-wrap:anywhere] [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono [&_code]:text-xs">
          {children}
          {actions ? <div className="mt-2 flex flex-wrap gap-2">{actions}</div> : null}
        </AlertDescription>
      ) : null}
    </Alert>
  )
}

const STATUS: Record<SubmissionStatusName, [string, LucideIcon, StatusTone]> = {
  approved: ['Live', CircleCheck, 'success'],
  changes_requested: ['Changes requested', CircleAlert, 'warning'],
  draft: ['Draft – choose a plan', Pencil, 'muted'],
  paid_pending_review: ['Live (paid, in review)', CircleCheck, 'success'],
  pending_badge: ['Pending badge', Clock, 'warning'],
  rejected: ['Rejected', CircleX, 'destructive'],
  verified: ['In review', Loader, 'info'],
  withdrawn: ['Withdrawn', Undo2, 'muted']
}

/** dashboard-01's status badge: an outline Badge with a toned lucide icon. */
export function SubmissionStatusBadge({ status }: { status: SubmissionStatusName }) {
  const [label, icon, tone] = STATUS[status]
  return (
    <StatusChip icon={icon} tone={tone}>
      {label}
    </StatusChip>
  )
}

/**
 * The product's logo in a rounded square: the shared listing image (#122), so a missing or
 * broken logo is the #86 tile, never alt text or a broken-image icon.
 */
export function ProductLogo({
  className,
  name,
  size = 40,
  src
}: {
  className?: string
  name: string
  size?: number
  src: string | null | undefined
}) {
  return <ListingImage className={cn('rounded-lg', className)} name={name} size={size} src={src} />
}

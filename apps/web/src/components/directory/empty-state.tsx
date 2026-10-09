import { FolderOpen } from 'lucide-react'
import Link from 'next/link'
import { Button, buttonVariants } from '@/components/ui/button'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@/components/ui/empty'

interface EmptyStateProps {
  title: string
  description: string
  actionLabel?: string
  actionHref?: string
  onAction?: () => void
}

/**
 * An empty list or search (serplists' `PageEmptyState`, #288): the stock `Empty` with an icon,
 * the title and description, and an optional action, a button or an in-site link. It sits inside
 * a page that has its own `h1`, so its title is an `h2`.
 */
export function EmptyState({
  title,
  description,
  actionLabel,
  actionHref,
  onAction
}: EmptyStateProps) {
  const action = !actionLabel ? null : onAction ? (
    <Button type="button" onClick={onAction}>
      {actionLabel}
    </Button>
  ) : actionHref ? (
    <Link href={actionHref} className={buttonVariants()}>
      {actionLabel}
    </Link>
  ) : null

  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <FolderOpen aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle className="text-2xl">
          <h2>{title}</h2>
        </EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {action ? (
        <EmptyContent className="flex-row flex-wrap justify-center">{action}</EmptyContent>
      ) : null}
    </Empty>
  )
}

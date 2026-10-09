import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

// Source reference: adapted from ShadcnBlocks feature3 and feature68.
interface DirectoryFeatureGridProps {
  children: ReactNode
  className?: string
}

interface DirectoryLinkListProps {
  children: ReactNode
  className?: string
}

interface DirectoryLinkListItemProps {
  children: ReactNode
  className?: string
}

function DirectoryFeatureGrid({ children, className }: DirectoryFeatureGridProps) {
  return <div className={cn('grid gap-4', className)}>{children}</div>
}

function DirectoryLinkList({ children, className }: DirectoryLinkListProps) {
  return (
    <div
      className={cn(
        'overflow-hidden rounded-2xl border border-border/50 bg-card/50 backdrop-blur-sm',
        className
      )}
    >
      <ul className="divide-y divide-border/50">{children}</ul>
    </div>
  )
}

function DirectoryLinkListItem({ children, className }: DirectoryLinkListItemProps) {
  return <li className={className}>{children}</li>
}

export type { DirectoryFeatureGridProps, DirectoryLinkListItemProps, DirectoryLinkListProps }
export { DirectoryFeatureGrid, DirectoryLinkList, DirectoryLinkListItem }

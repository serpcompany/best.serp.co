import type { ReactNode } from 'react'

import { cn } from '../../lib/utils'

// Source reference: adapted from ShadcnBlocks sidebar5 grouped navigation source.
const directoryNavigationInteractiveClassName =
  'group block rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'

interface DirectoryNavigationSectionProps {
  title: ReactNode
  children: ReactNode
  className?: string
  navClassName?: string
  titleClassName?: string
}

interface DirectoryNavigationItemProps {
  children: ReactNode
  icon?: ReactNode
  trailing?: ReactNode
  active?: boolean
  className?: string
}

function DirectoryNavigationSection({
  title,
  children,
  className,
  navClassName,
  titleClassName
}: DirectoryNavigationSectionProps) {
  return (
    <div className={className}>
      <h3 className={cn('mb-4 text-sm font-semibold text-muted-foreground', titleClassName)}>
        {title}
      </h3>
      <nav className={cn('space-y-1', navClassName)}>{children}</nav>
    </div>
  )
}

function DirectoryNavigationItem({
  children,
  icon,
  trailing,
  active = false,
  className
}: DirectoryNavigationItemProps) {
  return (
    <span
      className={cn(
        'flex items-center justify-between gap-2 rounded-md px-2 py-1 text-sm transition-colors',
        active
          ? 'bg-accent font-medium text-foreground'
          : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground group-hover:bg-muted/50 group-hover:text-foreground group-focus-visible:bg-muted/50 group-focus-visible:text-foreground',
        className
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        {icon}
        <span className="truncate">{children}</span>
      </span>
      {trailing}
    </span>
  )
}

export {
  DirectoryNavigationItem,
  DirectoryNavigationSection,
  directoryNavigationInteractiveClassName
}
export type { DirectoryNavigationItemProps, DirectoryNavigationSectionProps }

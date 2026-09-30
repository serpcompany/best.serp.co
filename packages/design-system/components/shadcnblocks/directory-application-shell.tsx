import type { ReactNode } from 'react'

import { cn } from '../../lib/utils'

// Source reference: adapted from ShadcnBlocks application-shell4, application-shell13, and navbar18.
interface DirectoryApplicationHeaderProps {
  children: ReactNode
  className?: string
}

interface DirectoryApplicationHeaderBarProps {
  children: ReactNode
  className?: string
}

interface DirectoryApplicationHeaderGroupProps {
  children: ReactNode
  className?: string
}

interface DirectoryApplicationNavProps {
  children: ReactNode
  className?: string
}

interface DirectoryApplicationSearchSurfaceProps {
  children: ReactNode
  className?: string
}

function DirectoryApplicationHeader({ children, className }: DirectoryApplicationHeaderProps) {
  return (
    <header
      className={cn(
        'sticky top-0 z-50 border-b border-border/50 bg-background/80 backdrop-blur-lg',
        className
      )}
    >
      {children}
    </header>
  )
}

function DirectoryApplicationHeaderBar({
  children,
  className
}: DirectoryApplicationHeaderBarProps) {
  return (
    <div
      className={cn(
        'flex h-16 w-full items-center justify-between gap-3 px-4 sm:gap-4 sm:px-6 2xl:grid 2xl:grid-cols-3 2xl:justify-center',
        className
      )}
    >
      {children}
    </div>
  )
}

function DirectoryApplicationHeaderGroup({
  children,
  className
}: DirectoryApplicationHeaderGroupProps) {
  return <div className={cn('flex items-center gap-2', className)}>{children}</div>
}

function DirectoryApplicationNav({ children, className }: DirectoryApplicationNavProps) {
  return <nav className={cn('hidden items-center gap-4 lg:flex', className)}>{children}</nav>
}

function DirectoryApplicationActions({
  children,
  className
}: DirectoryApplicationHeaderGroupProps) {
  return (
    <div className={cn('flex items-center gap-2 sm:gap-4 2xl:justify-end', className)}>
      {children}
    </div>
  )
}

function DirectoryApplicationSearchColumn({
  children,
  className
}: DirectoryApplicationSearchSurfaceProps) {
  return (
    <div className={cn('hidden max-w-2xl flex-1 md:block 2xl:w-full 2xl:max-w-none', className)}>
      {children}
    </div>
  )
}

function DirectoryApplicationMobileSearchBackdrop({
  children,
  className
}: DirectoryApplicationSearchSurfaceProps) {
  return <div className={cn('fixed inset-0 top-16 z-40 md:hidden', className)}>{children}</div>
}

function DirectoryApplicationMobileSearchPanel({
  children,
  className
}: DirectoryApplicationSearchSurfaceProps) {
  return (
    <div className={cn('fixed inset-x-0 top-16 z-50 bg-background md:hidden', className)}>
      {children}
    </div>
  )
}

export {
  DirectoryApplicationActions,
  DirectoryApplicationHeader,
  DirectoryApplicationHeaderBar,
  DirectoryApplicationHeaderGroup,
  DirectoryApplicationMobileSearchBackdrop,
  DirectoryApplicationMobileSearchPanel,
  DirectoryApplicationNav,
  DirectoryApplicationSearchColumn
}
export type {
  DirectoryApplicationHeaderBarProps,
  DirectoryApplicationHeaderGroupProps,
  DirectoryApplicationHeaderProps,
  DirectoryApplicationNavProps,
  DirectoryApplicationSearchSurfaceProps
}

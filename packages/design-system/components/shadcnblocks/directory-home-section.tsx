import type { ReactNode } from 'react'

import { cn } from '../../lib/utils'

// Source reference: adapted from ShadcnBlocks hero7, feature3, feature68, cta7, cta23, and cta34.
interface DirectoryHeroProps {
  children: ReactNode
  className?: string
}

interface DirectoryHeroContainerProps {
  children: ReactNode
  className?: string
}

interface DirectoryPageSectionProps {
  children: ReactNode
  className?: string
  labelledBy?: string
}

interface DirectorySectionHeaderProps {
  children: ReactNode
  className?: string
}

interface DirectorySectionTitleProps {
  children: ReactNode
  className?: string
  id?: string
}

interface DirectorySectionDescriptionProps {
  children: ReactNode
  className?: string
}

interface DirectorySectionActionProps {
  children: ReactNode
  className?: string
}

interface DirectoryFeatureGridProps {
  children: ReactNode
  className?: string
}

interface DirectoryCtaBandProps {
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

function DirectoryHero({ children, className }: DirectoryHeroProps) {
  return (
    <section className={cn('relative overflow-hidden py-12 md:py-16 lg:py-20', className)}>
      {children}
    </section>
  )
}

function DirectoryHeroContainer({ children, className }: DirectoryHeroContainerProps) {
  return (
    <div
      className={cn(
        'relative z-10 mx-auto max-w-4xl space-y-6 px-6 py-4 text-center md:space-y-8 md:py-8',
        className
      )}
    >
      {children}
    </div>
  )
}

function DirectoryPageSection({ children, className, labelledBy }: DirectoryPageSectionProps) {
  return (
    <section className={cn('space-y-6', className)} aria-labelledby={labelledBy}>
      {children}
    </section>
  )
}

function DirectorySectionHeader({ children, className }: DirectorySectionHeaderProps) {
  return (
    <div
      className={cn(
        '-mx-6 sticky top-16 z-30 flex items-center justify-between border-b border-border/50 bg-background/95 px-6 py-3 backdrop-blur-sm sm:py-4',
        className
      )}
    >
      {children}
    </div>
  )
}

function DirectorySectionTitle({ children, className, id }: DirectorySectionTitleProps) {
  return (
    <h2
      id={id}
      className={cn(
        'flex scroll-mt-20 items-center gap-2 text-xl font-bold tracking-tight sm:text-2xl',
        className
      )}
    >
      {children}
    </h2>
  )
}

function DirectorySectionDescription({ children, className }: DirectorySectionDescriptionProps) {
  return (
    <p className={cn('line-clamp-2 pl-3.5 text-xs text-muted-foreground sm:text-sm', className)}>
      {children}
    </p>
  )
}

function DirectorySectionAction({ children, className }: DirectorySectionActionProps) {
  return <div className={cn('ml-2 flex items-center gap-2', className)}>{children}</div>
}

function DirectoryFeatureGrid({ children, className }: DirectoryFeatureGridProps) {
  return <div className={cn('grid gap-4', className)}>{children}</div>
}

function DirectoryCtaBand({ children, className }: DirectoryCtaBandProps) {
  return (
    <section
      className={cn('rounded-2xl border border-border/50 bg-muted/30 py-8 sm:py-10', className)}
    >
      {children}
    </section>
  )
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

export {
  DirectoryCtaBand,
  DirectoryFeatureGrid,
  DirectoryHero,
  DirectoryHeroContainer,
  DirectoryLinkList,
  DirectoryLinkListItem,
  DirectoryPageSection,
  DirectorySectionAction,
  DirectorySectionDescription,
  DirectorySectionHeader,
  DirectorySectionTitle
}
export type {
  DirectoryCtaBandProps,
  DirectoryFeatureGridProps,
  DirectoryHeroContainerProps,
  DirectoryHeroProps,
  DirectoryLinkListItemProps,
  DirectoryLinkListProps,
  DirectoryPageSectionProps,
  DirectorySectionActionProps,
  DirectorySectionDescriptionProps,
  DirectorySectionHeaderProps,
  DirectorySectionTitleProps
}

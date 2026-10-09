import type { ReactNode } from 'react'
import { SectionHeader } from './section-header'

export type SectionProps = {
  title: string
  description?: string
  children: ReactNode
  viewAllHref?: string
  viewAllText?: string
  titleId?: string
}

/**
 * A titled band of a page: the shared `SectionHeader` (#257) over its content. With `titleId`,
 * the section is a region named by its title.
 */
export function Section({
  children,
  title,
  description,
  viewAllHref,
  viewAllText = 'View all',
  titleId
}: SectionProps) {
  return (
    <section aria-labelledby={titleId}>
      <SectionHeader
        id={titleId}
        title={title}
        description={description}
        action={viewAllHref ? { href: viewAllHref, label: viewAllText } : undefined}
      />
      {children}
    </section>
  )
}

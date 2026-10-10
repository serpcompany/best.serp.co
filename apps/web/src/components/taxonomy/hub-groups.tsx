import Link from 'next/link'
import type { ReactNode } from 'react'
import type { PublishedCategory } from '@/db/contracts'
import { getRoute } from '../../lib/routing/routes'
import { PageSection } from '../layout/page-shell'
import { SectionHeader } from '../layout/section-header'

/** Entries grouped under their hubs, the hubs by name (as the categories index orders them). */
export function groupByHub<T>(
  entries: T[],
  hubOf: (entry: T) => string,
  categories: PublishedCategory[]
): Array<{ entries: T[]; hub: PublishedCategory | { count: 0; name: string; slug: string } }> {
  const bySlug = new Map(categories.map(category => [category.slug, category]))
  const groups = new Map<string, T[]>()
  for (const entry of entries) {
    const slug = hubOf(entry)
    groups.set(slug, [...(groups.get(slug) ?? []), entry])
  }
  return [...groups]
    .map(([slug, grouped]) => ({
      entries: grouped,
      hub: bySlug.get(slug) ?? { count: 0 as const, name: slug, slug }
    }))
    .sort((left, right) => left.hub.name.localeCompare(right.hub.name))
}

/**
 * One hub's section of a taxonomy index (#341, design 2.1: the tag and best indexes are grouped
 * by hub): the hub's name, linked to its page while it renders, then its entries.
 */
export function HubGroupSection({
  children,
  hub
}: {
  children: ReactNode
  hub: { count: number; name: string; slug: string }
}) {
  const id = `hub-${hub.slug}`
  return (
    <PageSection spacing="compact" aria-labelledby={id}>
      <SectionHeader
        id={id}
        title={
          hub.count > 0 ? (
            <Link
              className="hover:underline"
              href={getRoute('category.page', { category: hub.slug })}
            >
              {hub.name}
            </Link>
          ) : (
            hub.name
          )
        }
      />
      {children}
    </PageSection>
  )
}

import Link from 'next/link'
import type { ReactNode } from 'react'
import { groupByHub } from '@/components/taxonomy/hub-groups'
import type { PublishedBestPage, PublishedCategory } from '@/db/contracts'
import { getRoute } from '@/lib/routing/routes'
import { cn } from '@/lib/utils'
import { PageContainer } from './page-shell'
import type { SiteLink } from './site-links'

/**
 * The link pages' layout (#53, the owner's "Option A, Sections"): the 404 page, the removed-listing
 * page and the HTML sitemap list each kind of link under its own heading, in the same grid of up to
 * four columns. Stock shadcn/ui has no link list, so these are plain lists, styled like the
 * footer's links. A name longer than its column (`CheckForPlagiarism.net` on a 360 px phone) breaks
 * inside the word instead of running past the viewport.
 */

export const sectionLinkClassName =
  'text-sm text-muted-foreground transition-colors hover:text-foreground'

/** Links under a subheading, such as one hub's best pages. */
export type LinkGroup = { key: string; links: readonly SiteLink[]; title: string }

/** The band of sections below a page's opening: a rule, then each section. */
export function LinkSections({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <PageContainer className={cn('flex flex-col gap-11 border-t pt-11 pb-16', className)}>
      {children}
    </PageContainer>
  )
}

/** One kind of link: its heading beside the links from `lg`, above them below it. */
export function LinkSection({
  children,
  id,
  title
}: {
  children: ReactNode
  id: string
  title: ReactNode
}) {
  return (
    <section
      aria-labelledby={id}
      className="grid gap-4 lg:grid-cols-[11rem_minmax(0,1fr)] lg:gap-8"
    >
      <h2 id={id} className="self-start text-base font-semibold tracking-tight">
        {title}
      </h2>
      <div className="min-w-0">{children}</div>
    </section>
  )
}

/** Links in two, three, then four columns. */
export function LinkGrid({ links }: { links: readonly SiteLink[] }) {
  return (
    <ul className="grid grid-cols-2 gap-x-6 gap-y-2.5 sm:grid-cols-3 lg:grid-cols-4">
      {links.map(link => (
        <li key={link.href} className="min-w-0 wrap-break-word">
          <Link href={link.href} className={sectionLinkClassName}>
            {link.label}
          </Link>
        </li>
      ))}
    </ul>
  )
}

/** Groups of links, each under its subheading, flowing through two, three, then four columns. */
export function LinkGroups({ groups }: { groups: readonly LinkGroup[] }) {
  return (
    <div className="-mb-6 columns-2 gap-x-6 sm:columns-3 lg:columns-4">
      {groups.map(group => (
        <div key={group.key} className="flex break-inside-avoid flex-col gap-2.5 pb-6">
          <h3 className="text-sm font-medium wrap-break-word">{group.title}</h3>
          <ul className="flex flex-col gap-2.5">
            {group.links.map(link => (
              <li key={link.href} className="wrap-break-word">
                <Link href={link.href} className={sectionLinkClassName}>
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

/** Each category's link, as given (the callers pass `linkedCategories`). */
export function categoryLinks(categories: readonly Pick<PublishedCategory, 'name' | 'slug'>[]) {
  return categories.map(category => ({
    href: getRoute('category.page', { category: category.slug }),
    label: category.name
  }))
}

/**
 * Best pages grouped under their hubs, the hubs by name and each hub's pages by heading: the
 * "Best of" section of the 404 page and the HTML sitemap.
 */
export function bestPageGroups(
  bestPages: readonly Pick<PublishedBestPage, 'heading' | 'hub' | 'slug'>[],
  categories: readonly PublishedCategory[]
): LinkGroup[] {
  const byHeading = [...bestPages].sort((left, right) => left.heading.localeCompare(right.heading))
  return groupByHub(byHeading, page => page.hub, [...categories]).map(({ entries, hub }) => ({
    key: hub.slug,
    links: entries.map(page => ({
      href: getRoute('best.page', { keyword: page.slug }),
      label: page.heading
    })),
    title: hub.name
  }))
}

import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { type BestPageSeeAll, BestPageView } from '@/components/taxonomy/best-page'
import {
  type BestPageItem,
  getActiveCategories,
  getBestPageBySlug,
  getBestPageItems,
  getBestPages,
  getTagBySlug,
  type PublishedBestPage
} from '@/lib/catalog/repository'
import { getRoute } from '@/lib/routing/routes'
import { type PageSearchParams, redirectMovedTaxonomyPage } from '@/lib/routing/taxonomy-redirect'
import { bestPageDescriptionLead, bestPageTitle, currentYear } from '@/lib/seo/page-titles'
import { composeMetaDescription, generateBaseMetadata } from '@/lib/seo/seo-config'
import { META_DESCRIPTION_MIN_LENGTH } from '@/lib/seo/seo-helpers'
import { bestPageEntryCount, isBestPageIndexable } from '@/lib/seo/taxonomy-indexing'

interface BestPageProps {
  params: Promise<{ keyword: string }>
  searchParams: Promise<PageSearchParams>
}

/** At most this many other best pages of the same hub (design 5.3). */
const RELATED_BEST_PAGES = 6

/** The active best page at `slug` with its entries, or null when it has none (a 404). */
async function publicBestPage(
  slug: string
): Promise<{ items: BestPageItem[]; page: PublishedBestPage } | null> {
  const page = await getBestPageBySlug(slug)
  if (!page || bestPageEntryCount(page) === 0) return null
  const items = await getBestPageItems(page.slug)
  return items.length ? { items, page } : null
}

/** The intro's first sentence, or all of it when it has no sentence break. */
function firstSentence(text: string): string {
  return /^.+?[.!?](?=\s|$)/su.exec(text.trim())?.[0] ?? text.trim()
}

/** How many of its top entries a short best page's meta description names first. */
const DESCRIPTION_ENTRY_NAMES = 3

/** "Includes A, B and C": the page's first `count` entries, in rank order. */
function includesEntries(items: readonly BestPageItem[], count: number): string {
  const names = items.slice(0, count).map(item => item.name)
  const last = names.pop()
  return `Includes ${names.length ? `${names.join(', ')} and ${last}` : last}`
}

/**
 * `base` padded while it is under the minimum length with the page's top entries (#426): three,
 * or fewer when three would pass the maximum, or more while three stay under the minimum. The
 * only words added to the entries' own names are "Includes" and "and".
 */
function bestPageDescription(base: string, items: readonly BestPageItem[]): string {
  // Longest first: `count` names, then one fewer, down to one.
  const padded = (count: number) =>
    composeMetaDescription(base, [
      Array.from({ length: count }, (_, index) => includesEntries(items, count - index))
    ])
  let count = Math.min(DESCRIPTION_ENTRY_NAMES, items.length)
  let description = padded(count)
  while (description.length < META_DESCRIPTION_MIN_LENGTH && count < items.length)
    description = padded(++count)
  return description
}

export async function generateMetadata({ params }: BestPageProps): Promise<Metadata> {
  const { keyword } = await params
  const found = await publicBestPage(keyword)
  if (!found)
    return { title: 'Page Not Found', description: 'The requested page could not be found.' }
  const { items, page } = found
  // `{N} Best {Keyword} in {Year}` from the page's own title (D1) and its exact entry count (#521);
  // the H1 stays the page's heading. The root layout's template adds ` | SERP Best`.
  const parts = { count: items.length, year: currentYear() }
  return generateBaseMetadata({
    title: bestPageTitle(page.title, parts),
    // Every word of the longest title, then the intro's first sentence (design 5.1), padded with
    // its top entries (#426).
    description: bestPageDescription(
      [bestPageDescriptionLead(page.title, parts), firstSentence(page.intro)]
        .filter(Boolean)
        .join(' '),
      items
    ),
    keywords: [page.keyword],
    noindex: !isBestPageIndexable(page),
    path: getRoute('best.page', { keyword: page.slug })
  })
}

/**
 * A best page (#341, design 1.3 and 5.1): a single page of at most `listSize` entries. With no
 * entry its URL answers one 308 to where `taxonomy_redirects` moved it, else 404.
 */
export default async function BestPage({ params, searchParams }: BestPageProps) {
  const [{ keyword }, resolvedSearchParams] = await Promise.all([params, searchParams])
  const found = await publicBestPage(keyword)
  if (!found) {
    await redirectMovedTaxonomyPage('best', keyword, resolvedSearchParams)
    notFound()
  }
  const { items, page } = found

  const [categories, bestPages, tag] = await Promise.all([
    getActiveCategories(),
    getBestPages(),
    page.tag ? getTagBySlug(page.tag) : Promise.resolve(null)
  ])
  const hub = categories.find(category => category.slug === page.hub)
  // "See all": the tag it ranks, else its category, while that page renders.
  const seeAll: BestPageSeeAll | null =
    tag && tag.count > 0
      ? { count: tag.count, href: getRoute('tag.page', { tag: tag.slug }), name: tag.name }
      : !page.tag && hub && hub.count > 0
        ? {
            count: hub.count,
            href: getRoute('category.page', { category: hub.slug }),
            name: hub.name
          }
        : null
  const related = bestPages
    .filter(
      candidate =>
        candidate.hub === page.hub &&
        candidate.slug !== page.slug &&
        bestPageEntryCount(candidate) > 0
    )
    .slice(0, RELATED_BEST_PAGES)

  return (
    <BestPageView
      categories={categories}
      items={items}
      page={page}
      related={related}
      seeAll={seeAll}
    />
  )
}

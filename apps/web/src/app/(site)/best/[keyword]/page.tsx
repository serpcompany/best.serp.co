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
import { composeMetaDescription, generateBaseMetadata } from '@/lib/seo/seo-config'
import { bestPageEntryCount, isBestPageIndexable } from '@/lib/seo/taxonomy-indexing'
import { formatListingCount } from '@/lib/site/site-copy'

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

export async function generateMetadata({ params }: BestPageProps): Promise<Metadata> {
  const { keyword } = await params
  const found = await publicBestPage(keyword)
  if (!found)
    return { title: 'Page Not Found', description: 'The requested page could not be found.' }
  const { items, page } = found
  // The title and H1 are the page's own (D1); the root layout's template adds " | SERP".
  return generateBaseMetadata({
    title: page.title,
    // The intro's first sentence plus the count (design 5.1).
    description: composeMetaDescription(
      [firstSentence(page.intro), `${formatListingCount(items.length)}.`].filter(Boolean).join(' ')
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

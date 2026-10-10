import { ArrowRight, ChevronRight, ExternalLink } from 'lucide-react'
import Link from 'next/link'
import type { BestPageItem, PublishedBestPage, PublishedCategory } from '@/db/contracts'
import { getCategoryIcon } from '@/lib/directory/categories'
import { cn } from '@/lib/utils'
import { withDubVia } from '../../lib/analytics/dub-via'
import { getRoute } from '../../lib/routing/routes'
import { SITE_NAME, siteLogoUrl, siteOrigin, siteWebsiteId } from '../../lib/seo/seo-config'
import { bestPageEntryCount } from '../../lib/seo/taxonomy-indexing'
import { siteConfig } from '../../lib/site/site-config'
import { CardGrid } from '../layout/card-grid'
import { ListCard } from '../layout/list-card'
import { PageHero } from '../layout/page-hero'
import { PageSection } from '../layout/page-shell'
import { SectionHeader } from '../layout/section-header'
import { SiteBreadcrumb } from '../layout/site-breadcrumb'
import { ListingImage } from '../listing/listing-image'
import { JsonLd } from '../seo/json-ld'
import { Badge } from '../ui/badge'
import { buttonVariants } from '../ui/button'
import { Card } from '../ui/card'
import { outboundWebsiteRel } from '../website/website-detail-header'

/** Where a best page's "See all" goes: its tag's page, else its hub's (design 5.1). */
export interface BestPageSeeAll {
  count: number
  href: string
  name: string
}

/** "Updated October 8, 2026": the page's sitemap `lastmod`, as a date. */
export function formatUpdatedDate(instant: string): string {
  return new Date(instant).toLocaleDateString('en-US', {
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
    year: 'numeric'
  })
}

/**
 * A best page's structured data (design 5.1): a `CollectionPage` whose `mainEntity` is its entries
 * as an ordered `ItemList`, with a `BreadcrumbList` of Home, Best and the page. It names no
 * `Review` or `AggregateRating`: D1 holds no ratings.
 */
export function bestPageSchema(page: PublishedBestPage, items: BestPageItem[]) {
  const origin = siteOrigin()
  const path = getRoute('best.page', { keyword: page.slug })
  const pageUrl = `${origin}${path}`
  return {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    '@id': pageUrl,
    name: page.title,
    headline: page.heading,
    description: page.intro,
    url: pageUrl,
    inLanguage: 'en-US',
    isPartOf: {
      '@type': 'WebSite',
      '@id': siteWebsiteId(),
      name: SITE_NAME,
      description: siteConfig.description,
      url: origin
    },
    breadcrumb: {
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: origin },
        {
          '@type': 'ListItem',
          position: 2,
          name: 'Best',
          item: `${origin}${getRoute('best.index')}`
        },
        { '@type': 'ListItem', position: 3, name: page.heading, item: pageUrl }
      ]
    },
    mainEntity: {
      '@type': 'ItemList',
      name: page.heading,
      numberOfItems: items.length,
      itemListOrder: 'https://schema.org/ItemListOrderAscending',
      itemListElement: items.map((item, index) => ({
        '@type': 'ListItem',
        position: index + 1,
        url: `${origin}${getRoute('listing.detail', { slug: item.slug })}`,
        name: item.name
      }))
    },
    publisher: {
      '@type': 'Organization',
      name: SITE_NAME,
      url: origin,
      logo: { '@type': 'ImageObject', url: siteLogoUrl() }
    },
    dateModified: page.lastModifiedAt
  }
}

/** One entry: its position, logo, name, blurb or description, chips, and "Visit Site" (5.1). */
function BestPageEntry({
  hub,
  item,
  position
}: {
  hub: PublishedCategory | undefined
  item: BestPageItem
  position: number
}) {
  return (
    <Card className="flex-row flex-wrap items-start gap-4 p-4 sm:flex-nowrap sm:p-5">
      <span className="w-6 shrink-0 pt-3 text-right text-lg font-semibold tabular-nums text-muted-foreground">
        {position}
      </span>
      {/* Wrapped: Card drops its top padding when an image is its first child. */}
      <div className="shrink-0">
        <ListingImage name={item.name} src={item.media?.logo} size={48} className="rounded-lg" />
      </div>
      <div className="flex min-w-0 flex-1 basis-48 flex-col gap-2">
        <h2 className="text-lg font-semibold">
          <Link
            href={getRoute('listing.detail', { slug: item.slug })}
            className="hover:underline"
            data-analytics="website-click"
            data-source="best"
            data-website-name={item.name}
            data-website-slug={item.slug}
          >
            {item.name}
          </Link>
        </h2>
        <p className="text-sm text-muted-foreground">{item.blurb ?? item.description}</p>
        {hub || item.tags.length ? (
          <div className="flex flex-wrap gap-1.5">
            {hub ? (
              <Badge
                variant="secondary"
                render={<Link href={getRoute('category.page', { category: hub.slug })} />}
              >
                {hub.name}
              </Badge>
            ) : null}
            {item.tags.map(tag => (
              <Badge
                key={tag.slug}
                variant="outline"
                render={<Link href={getRoute('tag.page', { tag: tag.slug })} />}
              >
                {tag.name}
              </Badge>
            ))}
          </div>
        ) : null}
      </div>
      <div className="flex basis-full justify-end sm:basis-auto">
        <Link
          href={withDubVia(item.website)}
          target="_blank"
          rel={outboundWebsiteRel(item.linkRel)}
          className={buttonVariants({ size: 'sm', variant: 'outline' })}
        >
          Visit Site
          <ExternalLink data-icon="inline-end" aria-hidden />
        </Link>
      </div>
    </Card>
  )
}

/**
 * A best page (`/best/<keyword>/`, #341 design 5.1 and 5.3): its H1, intro and last update, its
 * entries in rank order, a "See all" link to the tag or hub it ranks, and up to six best pages
 * of the same hub.
 */
export function BestPageView({
  categories,
  items,
  page,
  related,
  seeAll
}: {
  /** Active categories, for the entries' hub chips. */
  categories: PublishedCategory[]
  items: BestPageItem[]
  page: PublishedBestPage
  /** Other best pages of its hub, with entries. */
  related: PublishedBestPage[]
  seeAll: BestPageSeeAll | null
}) {
  const origin = siteOrigin()
  const path = getRoute('best.page', { keyword: page.slug })
  // Only a hub whose page renders is a chip.
  const hubs = new Map(
    categories.filter(category => category.count > 0).map(category => [category.slug, category])
  )
  const hub = hubs.get(page.hub)

  return (
    <>
      <JsonLd data={bestPageSchema(page, items)} />
      <PageSection spacing="hero" className="border-b">
        <SiteBreadcrumb
          items={[
            { name: 'Best', href: getRoute('best.index') },
            { name: page.heading, href: path }
          ]}
          baseUrl={origin}
        />
        <PageHero
          eyebrow={
            <>
              Updated{' '}
              <time dateTime={page.lastModifiedAt}>{formatUpdatedDate(page.lastModifiedAt)}</time>
            </>
          }
          title={page.heading}
          description={page.intro || undefined}
        />
      </PageSection>
      <PageSection spacing="spacious">
        <ol className="flex flex-col gap-4" data-slot="best-page-entries">
          {items.map((item, index) => (
            <li key={item.slug}>
              <BestPageEntry hub={hubs.get(item.category)} item={item} position={index + 1} />
            </li>
          ))}
        </ol>
        {seeAll ? (
          <div className="mt-8">
            <Link href={seeAll.href} className={buttonVariants({ variant: 'outline' })}>
              See all {seeAll.count} {seeAll.name}
              <ArrowRight data-icon="inline-end" />
            </Link>
          </div>
        ) : null}
      </PageSection>
      {hub && related.length ? (
        <PageSection spacing="spacious" className="border-t" aria-labelledby="related-best-pages">
          <SectionHeader id="related-best-pages" title={`Best ${hub.name} lists`} />
          <BestPageCards pages={related} />
        </PageSection>
      ) : null}
    </>
  )
}

/** Best pages as linked cards with their entry counts: the index and a page's related lists. */
export function BestPageCards({
  className,
  pages
}: {
  className?: string
  pages: PublishedBestPage[]
}) {
  return (
    <CardGrid as="ul" className={cn(className)}>
      {pages.map(page => {
        const Icon = getCategoryIcon(page.hub)
        return (
          <li key={page.slug}>
            <ListCard
              className="h-full"
              href={getRoute('best.page', { keyword: page.slug })}
              icon={<Icon />}
              meta={
                <>
                  <Badge variant="secondary">{bestPageEntryCount(page)}</Badge>
                  <ChevronRight aria-hidden="true" className="size-4" />
                </>
              }
              title={page.heading}
            />
          </li>
        )
      })}
    </CardGrid>
  )
}

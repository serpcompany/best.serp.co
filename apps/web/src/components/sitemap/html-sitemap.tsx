import type { Metadata } from 'next'
import Link from 'next/link'
import { Separator } from '@/components/ui/separator'
import type { PublishedBestPage, PublishedCategory } from '@/db/contracts'
import { getRoute } from '@/lib/routing/routes'
import {
  type HtmlSitemapLink,
  type HtmlSitemapPage,
  htmlSitemapListingsPath
} from '@/lib/seo/html-sitemap'
import { generateBaseMetadata, SITE_NAME, siteOrigin } from '@/lib/seo/seo-config'
import { isBestPageIndexable, linkedCategories } from '@/lib/seo/taxonomy-indexing'
import { siteCopy } from '@/lib/site/site-copy'
import { ListingPagination } from '../directory/listing-pagination'
import { PageHero } from '../layout/page-hero'
import { PageSection } from '../layout/page-shell'
import { type BreadcrumbItemData, SiteBreadcrumb } from '../layout/site-breadcrumb'
import type { SiteLink } from '../layout/site-links'

/**
 * The HTML sitemap (#53; serp web-stack/html-sitemap.md, after serp.co's `/sitemap/`): links under
 * plain headings, every one to an indexable page. `/sitemap/` lists the hub pages and the numbered
 * listing pages; each numbered page lists up to 200 listings, oldest first.
 */

type SitemapGroup = { id: string; links: SiteLink[]; title: string }

const linkClassName = 'text-sm text-muted-foreground transition-colors hover:text-foreground'

/** Links in columns, each group under its heading. */
function SitemapLinkGroup({ group }: { group: SitemapGroup }) {
  return (
    <section aria-labelledby={group.id}>
      <Separator />
      <h2 id={group.id} className="pt-6 text-sm font-medium">
        {group.title}
      </h2>
      <ul className="mt-4 columns-1 gap-x-10 sm:columns-2 lg:columns-4">
        {group.links.map(link => (
          <li key={link.href} className="break-inside-avoid py-1.5">
            <Link href={link.href} className={linkClassName}>
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function htmlSitemapMetadata(): Metadata {
  return generateBaseMetadata({
    title: 'Sitemap',
    description: `Links to every category, best list and ${siteCopy.listingName.singular} on ${SITE_NAME}.`,
    path: getRoute('sitemap.index')
  })
}

/**
 * `/sitemap/`'s groups: the indexable static pages, every category whose page renders, every
 * indexable best page, then the numbered listing pages. A group with no link is left out.
 */
export function htmlSitemapGroups({
  bestPages,
  categories,
  listingPageCount,
  pages
}: {
  bestPages: readonly PublishedBestPage[]
  categories: readonly PublishedCategory[]
  listingPageCount: number
  /** `sitemapPageLinks` */
  pages: SiteLink[]
}): SitemapGroup[] {
  const groups: SitemapGroup[] = [
    { id: 'sitemap-pages', links: pages, title: 'Pages' },
    {
      id: 'sitemap-categories',
      links: linkedCategories(categories).map(category => ({
        href: getRoute('category.page', { category: category.slug }),
        label: category.name
      })),
      title: 'Categories'
    },
    {
      id: 'sitemap-best',
      links: bestPages
        .filter(isBestPageIndexable)
        .sort((left, right) => left.heading.localeCompare(right.heading))
        .map(page => ({
          href: getRoute('best.page', { keyword: page.slug }),
          label: page.heading
        })),
      title: 'Best'
    },
    {
      id: 'sitemap-listings',
      links: Array.from({ length: listingPageCount }, (_, index) => ({
        href: htmlSitemapListingsPath(index + 1),
        label: `Page ${index + 1}`
      })),
      title: siteCopy.listingName.pluralTitle
    }
  ]
  return groups.filter(group => group.links.length > 0)
}

export function HtmlSitemapIndex({ groups }: { groups: SitemapGroup[] }) {
  return (
    <>
      <PageSection spacing="hero" className="border-b">
        <SiteBreadcrumb
          items={[{ name: 'Sitemap', href: getRoute('sitemap.index') }]}
          baseUrl={siteOrigin()}
        />
        <PageHero title="Sitemap" />
      </PageSection>
      <PageSection spacing="spacious" containerClassName="flex flex-col gap-12">
        {groups.map(group => (
          <SitemapLinkGroup key={group.id} group={group} />
        ))}
      </PageSection>
    </>
  )
}

/** A numbered page's metadata: indexable and canonical to itself, with its own title. */
export function htmlSitemapListingsMetadata(page: number): Metadata {
  const { pluralTitle, singular } = siteCopy.listingName
  const suffix = page > 1 ? ` - Page ${page}` : ''
  return generateBaseMetadata({
    title: `Sitemap: ${pluralTitle}${suffix}`,
    description: `Links to every ${singular} on ${SITE_NAME}, page ${page}.`,
    path: htmlSitemapListingsPath(page)
  })
}

/** A numbered page: its listings' links in columns, then the page links. */
export function HtmlSitemapListings({ result }: { result: HtmlSitemapPage<HtmlSitemapLink> }) {
  const { pluralTitle } = siteCopy.listingName
  const { items, page, pageCount } = result
  const breadcrumb: BreadcrumbItemData[] = [
    { name: 'Sitemap', href: getRoute('sitemap.index') },
    { name: pluralTitle, href: htmlSitemapListingsPath(1) },
    ...(page > 1 ? [{ name: `Page ${page}`, href: htmlSitemapListingsPath(page) }] : [])
  ]
  return (
    <>
      <PageSection spacing="hero" className="border-b">
        <SiteBreadcrumb items={breadcrumb} baseUrl={siteOrigin()} />
        <PageHero title={pluralTitle} description={`Page ${page} of ${pageCount}`} />
      </PageSection>
      <PageSection spacing="spacious">
        <ul className="columns-1 gap-x-10 sm:columns-2 lg:columns-4">
          {items.map(item => (
            <li key={item.slug} className="break-inside-avoid py-1.5">
              <Link
                href={getRoute('listing.detail', { slug: item.slug })}
                className={linkClassName}
              >
                {item.name}
              </Link>
            </li>
          ))}
        </ul>
        <ListingPagination
          basePath={htmlSitemapListingsPath(1)}
          label="Sitemap pages"
          page={page}
          pageCount={pageCount}
          pageHref={htmlSitemapListingsPath}
        />
      </PageSection>
    </>
  )
}

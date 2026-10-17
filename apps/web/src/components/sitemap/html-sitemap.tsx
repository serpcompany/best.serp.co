import type { Metadata } from 'next'
import Link from 'next/link'
import type { PublishedBestPage, PublishedCategory } from '@/db/contracts'
import { getRoute } from '@/lib/routing/routes'
import {
  type HtmlSitemapLink,
  type HtmlSitemapPage,
  htmlSitemapListingPageLinks,
  htmlSitemapListingsPath,
  htmlSitemapRangeOf
} from '@/lib/seo/html-sitemap'
import { generateBaseMetadata, SITE_NAME, siteOrigin } from '@/lib/seo/seo-config'
import { isBestPageIndexable, linkedCategories } from '@/lib/seo/taxonomy-indexing'
import { siteCopy } from '@/lib/site/site-copy'
import { ListingPagination } from '../directory/listing-pagination'
import {
  bestPageGroups,
  categoryLinks,
  LinkGrid,
  type LinkGroup,
  LinkGroups,
  LinkSection,
  LinkSections,
  sectionLinkClassName
} from '../layout/link-sections'
import { PageHero } from '../layout/page-hero'
import { PageSection } from '../layout/page-shell'
import { type BreadcrumbItemData, SiteBreadcrumb } from '../layout/site-breadcrumb'
import type { SiteLink } from '../layout/site-links'

/**
 * The HTML sitemap (#53; serp web-stack/html-sitemap.md, after serp.co's `/sitemap/`), in the
 * owner's "Option A, Sections": each kind of link under its own heading, every one to an indexable
 * page. `/sitemap/` lists the hub pages and the numbered listing pages; each numbered page lists up
 * to 200 listings, oldest first.
 */

export type SitemapSection = { id: string; title: string } & (
  | { groups: LinkGroup[] }
  | { links: SiteLink[] }
)

export function htmlSitemapMetadata(): Metadata {
  return generateBaseMetadata({
    title: 'Sitemap',
    description: `Links to every category, best list and ${siteCopy.listingName.singular} on ${SITE_NAME}.`,
    path: getRoute('sitemap.index')
  })
}

/**
 * `/sitemap/`'s sections: the indexable static pages, every category whose page renders, every
 * indexable best page under its hub, then the numbered listing pages, labelled by range. A section
 * with no link is left out.
 */
export function htmlSitemapSections({
  bestPages,
  categories,
  listingTotal,
  pages
}: {
  bestPages: readonly PublishedBestPage[]
  categories: readonly PublishedCategory[]
  /** How many listings the numbered pages list. */
  listingTotal: number
  /** `sitemapPageLinks` */
  pages: SiteLink[]
}): SitemapSection[] {
  const sections: SitemapSection[] = [
    { id: 'sitemap-pages', links: pages, title: 'Pages' },
    {
      id: 'sitemap-categories',
      links: categoryLinks(linkedCategories(categories)),
      title: 'Categories'
    },
    {
      groups: bestPageGroups(bestPages.filter(isBestPageIndexable), categories),
      id: 'sitemap-best',
      title: 'Best of'
    },
    { id: 'sitemap-listings', links: htmlSitemapListingPageLinks(listingTotal), title: 'Listings' }
  ]
  return sections.filter(section =>
    'groups' in section ? section.groups.length > 0 : section.links.length > 0
  )
}

export function HtmlSitemapIndex({ sections }: { sections: SitemapSection[] }) {
  return (
    <>
      <PageSection spacing="hero">
        <SiteBreadcrumb
          items={[{ name: 'Sitemap', href: getRoute('sitemap.index') }]}
          baseUrl={siteOrigin()}
        />
        <PageHero title="Sitemap" />
      </PageSection>
      <LinkSections>
        {sections.map(section => (
          <LinkSection key={section.id} id={section.id} title={section.title}>
            {'groups' in section ? (
              <LinkGroups groups={section.groups} />
            ) : (
              <LinkGrid links={section.links} />
            )}
          </LinkSection>
        ))}
      </LinkSections>
    </>
  )
}

/** A numbered page's metadata: indexable and canonical to itself, with its own title. */
export function htmlSitemapListingsMetadata(page: number): Metadata {
  const suffix = page > 1 ? ` - Page ${page}` : ''
  return generateBaseMetadata({
    title: `Sitemap: Listings${suffix}`,
    description: `Links to every ${siteCopy.listingName.singular} on ${SITE_NAME}, page ${page}.`,
    path: htmlSitemapListingsPath(page)
  })
}

/** A numbered page: its range of the whole, its listings' links in columns, then the page links. */
export function HtmlSitemapListings({ result }: { result: HtmlSitemapPage<HtmlSitemapLink> }) {
  const { items, page, pageCount, total } = result
  const breadcrumb: BreadcrumbItemData[] = [
    { name: 'Sitemap', href: getRoute('sitemap.index') },
    { name: 'Listings', href: htmlSitemapListingsPath(page) }
  ]
  return (
    <>
      <PageSection spacing="hero">
        <SiteBreadcrumb items={breadcrumb} baseUrl={siteOrigin()} />
        <PageHero
          title="Listings"
          description={total > 0 ? htmlSitemapRangeOf(page, total) : undefined}
        />
      </PageSection>
      <LinkSections>
        <ul className="columns-2 gap-x-6 sm:columns-3 lg:columns-4">
          {items.map(item => (
            <li key={item.slug} className="break-inside-avoid py-1.25">
              <Link
                href={getRoute('listing.detail', { slug: item.slug })}
                className={sectionLinkClassName}
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
      </LinkSections>
    </>
  )
}

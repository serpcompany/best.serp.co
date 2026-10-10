import { ArrowRight } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'
import type { ReactElement } from 'react'
import { buttonVariants } from '@/components/ui/button'
import {
  toWebsiteBrowseCardMetadata,
  type WebsiteMetadata
} from '../../lib/directory/content-query'
import { getRoute } from '../../lib/routing/routes'
import {
  generateBaseMetadata,
  generateWebsiteSchema,
  KEYWORDS,
  siteUrl
} from '../../lib/seo/seo-config'
import { siteConfig } from '../../lib/site/site-config'
import { siteCopy } from '../../lib/site/site-copy'
import { type ListingPageInfo, ListingPagination } from '../directory/listing-pagination'
import { PageHero } from '../layout/page-hero'
import { PageContainer, PageSection } from '../layout/page-shell'
import { FeaturedProjectsSection } from '../sections/featured-projects-section'
import { RecentlyAddedSection } from '../sections/recently-added-section'
import { StaticWebsitesList } from '../sections/static-websites-list'
import { JsonLd } from '../seo/json-ld'

/** One page of the directory, already in directory (name) order. */
export interface DirectoryPage extends ListingPageInfo {
  items: WebsiteMetadata[]
  pageSize: number
}

export interface HomePageData {
  browse: DirectoryPage
  featuredProjects: WebsiteMetadata[]
  recentlyUpdatedProjects: WebsiteMetadata[]
  totalCount: number
}

interface BuildHomePageDataInput {
  browse: DirectoryPage
  /** Featured listings in publication order (the `is_featured` placement flag). */
  featured: WebsiteMetadata[]
  /** Latest listings in publication order. */
  latest: WebsiteMetadata[]
  totalCount: number
}

const HOMEPAGE_CARD_SECTION_SIZE = 8

export function buildHomePageData({
  browse,
  featured,
  latest,
  totalCount
}: BuildHomePageDataInput): HomePageData {
  return {
    browse,
    // Without featured listings the section falls back to the newest ones, as before.
    featuredProjects: (featured.length ? featured : latest).slice(0, HOMEPAGE_CARD_SECTION_SIZE),
    recentlyUpdatedProjects: latest.slice(0, HOMEPAGE_CARD_SECTION_SIZE),
    totalCount
  }
}

const HOME_TITLE = `${siteConfig.name} Directory of ${siteCopy.listingName.pluralTitle} and Resources`

/**
 * With `trailingSlash`, the Next.js metadata API appends `/` to every same-origin URL, so it
 * would write the homepage canonical and `og:url` as `https://best.serp.co/`. The homepage
 * therefore leaves both unset here and renders `HomePageCanonicalTags` instead. See the URL
 * trailing-slash standard. Built per request: the origin is this environment's (#359).
 */
export function homePageMetadata(): Metadata {
  const {
    alternates: _homeAlternates,
    openGraph: homeOpenGraph,
    ...homeMetadata
  } = generateBaseMetadata({
    title: HOME_TITLE,
    description: `${siteConfig.tagline}. Browse curated ${siteCopy.listingName.plural}, resources, and documentation links in one searchable directory.`,
    keywords: [
      ...KEYWORDS.homepage,
      ...KEYWORDS.global,
      'directory listings',
      'curated resources',
      'documentation links',
      'resource directory',
      'searchable directory'
    ],
    path: '/'
  })
  return {
    ...homeMetadata,
    // The homepage sits in `(site)`, below the root layout, so its title template would add
    // ` | SERP`; the homepage title is already the full name.
    title: { absolute: HOME_TITLE },
    openGraph: { ...homeOpenGraph, url: undefined }
  }
}

/**
 * The homepage canonical and `og:url`, written as the bare origin (`https://best.serp.co`, never
 * `https://best.serp.co/`). React hoists both tags into `<head>`. The homepage renders it, and
 * so does `/products/`'s first page, whose canonical is `/` (#167); its later pages keep their
 * own canonical metadata.
 */
export function HomePageCanonicalTags(): ReactElement {
  const homeUrl = siteUrl('/')
  return (
    <>
      <link rel="canonical" href={homeUrl} />
      <meta property="og:url" content={homeUrl} />
    </>
  )
}

export function HomePageRoute({ data }: { data: HomePageData }): ReactElement {
  const { browse, featuredProjects, recentlyUpdatedProjects, totalCount } = data

  return (
    <>
      <JsonLd data={generateWebsiteSchema()} />
      <PageSection spacing="hero" className="border-b">
        <PageHero
          eyebrow={`${totalCount} ${siteCopy.listingCountLabel}`}
          title={siteConfig.name}
          description={`${siteConfig.tagline} and browse curated ${siteCopy.listingName.plural}, resources, and documentation links in one searchable directory`}
          actions={
            <Link href={getRoute('submit')} className={buttonVariants({ size: 'lg' })}>
              {siteCopy.submitLabel}
              <ArrowRight data-icon="inline-end" />
            </Link>
          }
        />
      </PageSection>
      <PageContainer className="flex flex-col gap-12 py-12">
        <FeaturedProjectsSection projects={featuredProjects.map(toWebsiteBrowseCardMetadata)} />
        <RecentlyAddedSection websites={recentlyUpdatedProjects.map(toWebsiteBrowseCardMetadata)} />
        <StaticWebsitesList
          websites={browse.items.map(toWebsiteBrowseCardMetadata)}
          totalCount={totalCount}
          displayLimit={browse.pageSize}
          pagination={
            <ListingPagination
              basePath={getRoute('listing.list')}
              fragment={siteCopy.allAnchorId}
              page={browse.page}
              pageCount={browse.pageCount}
            />
          }
        />
      </PageContainer>
    </>
  )
}

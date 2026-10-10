import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import type { PublishedBestPage } from '@/db/contracts'
import { getCategoryDisplayName } from '../../lib/directory/category-display'
import type {
  TaxonomyName,
  WebsiteDetailMetadata,
  WebsiteMetadata
} from '../../lib/directory/content-query'
import { resolveListingDetailTemplate } from '../../lib/directory/listing-detail-template'
import { getCanonicalListingListRoute, getRoute } from '../../lib/routing/routes'
import { generateWebsiteDetailSchema } from '../../lib/seo/schema'
import { composeMetaDescription, generateDynamicMetadata } from '../../lib/seo/seo-config'
import { siteConfig } from '../../lib/site/site-config'
import { siteCopy } from '../../lib/site/site-copy'
import { ProjectNavigation } from '../directory/project-navigation'
import { DetailPageLayout } from '../layout/detail-page-layout'
import { SectionHeader } from '../layout/section-header'
import { ListingImage } from '../listing/listing-image'
import { JsonLd } from '../seo/json-ld'
import { BestPageCards } from '../taxonomy/best-page'
import { WebsiteContentSection } from '../website/website-content-section'
import {
  WebsiteDetailActions,
  WebsiteDetailAside,
  websiteDetailMeta
} from '../website/website-detail-header'
import { faqsToShow, WebsiteFaqsSection } from '../website/website-faqs-section'
import { WebsiteRelatedProjects } from '../website/website-related-projects'
import { WebsiteResourcesSection } from '../website/website-resources-section'

type WebsiteResourcesSectionWebsite = Pick<WebsiteDetailMetadata, 'resourceLinks'>

export async function generateWebsiteDetailRouteMetadata(
  project: WebsiteDetailMetadata
): Promise<Metadata> {
  const categoryFormatted = project.category ? getCategoryDisplayName(project.category) : null

  // Short descriptions are padded with directory context, long ones truncated (#151).
  const seoDescription = composeMetaDescription(project.description, [
    [
      `Explore ${project.name} in the ${siteConfig.name} directory, with resource links, category details, and related entries.`,
      `Explore ${project.name} in the ${siteConfig.name} directory.`
    ],
    categoryFormatted ? [`Category: ${categoryFormatted}.`] : []
  ])

  const keywords = [
    project.name,
    `${project.name} ${siteCopy.listingName.singular}`,
    `${project.name} resources`,
    project.category,
    `${siteCopy.listingName.singular} details`,
    'directory listings',
    'resource links',
    categoryFormatted
  ].filter(Boolean) as string[]

  return generateDynamicMetadata({
    type: 'listing',
    name: project.name,
    description: seoDescription,
    slug: project.slug,
    additionalKeywords: keywords,
    publishedAt: project.publishedAt,
    // Open Graph `modifiedTime`, the same value as JSON-LD `dateModified` (#218).
    updatedAt: project.modifiedAt
  })
}

export function generateWebsiteDetailRouteStaticParams(
  websites: WebsiteMetadata[]
): Array<{ slug: string }> {
  if (!websites || websites.length === 0) {
    return []
  }

  return websites
    .filter(website => website.slug && typeof website.slug === 'string')
    .map(website => ({
      slug: website.slug
    }))
}

/**
 * A listing's categories, its hub (the primary) first, named from D1 (#347): `categoryNames` is
 * the shell stats' names by slug. A slug they lack keeps its checked-in name.
 */
export function listingCategoryNames(
  project: Pick<WebsiteDetailMetadata, 'categories' | 'category'>,
  categoryNames: ReadonlyMap<string, string>
): TaxonomyName[] {
  return [...(project.category ? [project.category] : []), ...(project.categories ?? [])]
    .filter((slug, index, slugs) => Boolean(slug) && slugs.indexOf(slug) === index)
    .map(slug => ({ name: categoryNames.get(slug) ?? getCategoryDisplayName(slug), slug }))
}

export function WebsiteDetailRoutePage({
  categoryNames = new Map(),
  claim,
  featuredIn = [],
  project
}: {
  /** Category names from D1 by slug (the shell stats): the hub's crumb and badge (#347). */
  categoryNames?: ReadonlyMap<string, string>
  /** The claim link of a listing without an owner, while claims are on (#67). */
  claim?: ReactNode
  /** The best pages that show the listing (`featuredInBestPages`, #347): "Featured in". */
  featuredIn?: readonly PublishedBestPage[]
  project: WebsiteDetailMetadata
}) {
  const categories = listingCategoryNames(project, categoryNames)
  const hub = categories[0]
  const detailTemplate = resolveListingDetailTemplate(project.entityType)
  const resourcesWebsite: WebsiteResourcesSectionWebsite = {
    ...(project.resourceLinks ? { resourceLinks: project.resourceLinks } : {})
  }
  const verifiedOwner = project.verifiedOwner ? { verifiedOwner: true as const } : {}

  return (
    <div data-entity-type={project.entityType || 'listing'} data-listing-template={detailTemplate}>
      <JsonLd data={generateWebsiteDetailSchema(project, hub)} />

      {/* serplists' detail page (#273); the JSON-LD graph above carries the breadcrumb. */}
      <DetailPageLayout
        breadcrumbs={[
          { href: getCanonicalListingListRoute(), label: siteCopy.listingName.pluralTitle },
          ...(hub
            ? [{ href: getRoute('category.page', { category: hub.slug }), label: hub.name }]
            : []),
          { label: project.name }
        ]}
        media={
          <ListingImage
            name={project.name}
            src={project.media?.logo}
            size={56}
            className="rounded-xl"
          />
        }
        title={project.name}
        description={project.description}
        meta={websiteDetailMeta({
          categories,
          ...(project.isUnofficial ? { isUnofficial: true } : {}),
          ...(project.tags?.length ? { tags: project.tags } : {}),
          ...verifiedOwner
        })}
        actions={
          <WebsiteDetailActions
            website={{
              // D1 details always carry the setting; a missing one fails safe to nofollow.
              linkRel: project.linkRel ?? 'nofollow',
              slug: project.slug,
              website: project.website
            }}
          />
        }
        aside={
          <WebsiteDetailAside claim={claim} website={{ slug: project.slug, ...verifiedOwner }} />
        }
      >
        <div className="flex flex-col gap-12">
          {/* The listing's own text, links and FAQs read in one column. */}
          <div className="flex max-w-3xl flex-col gap-12">
            <WebsiteContentSection contentTree={project.contentTree} website={project} />

            <WebsiteResourcesSection website={resourcesWebsite} />

            <WebsiteFaqsSection website={{ faqs: faqsToShow(project.faqs, project.content) }} />
          </div>

          {featuredIn.length > 0 ? (
            <section aria-labelledby="featured-in-heading">
              <SectionHeader id="featured-in-heading" title="Featured in" />
              <BestPageCards pages={featuredIn} />
            </section>
          ) : null}

          <section aria-labelledby="browse-more-heading">
            <SectionHeader id="browse-more-heading" title="Browse more" />
            <ProjectNavigation
              previousWebsite={project.previousWebsite}
              nextWebsite={project.nextWebsite}
            />
          </section>

          {project.relatedWebsites?.length > 0 && (
            <WebsiteRelatedProjects websites={project.relatedWebsites} />
          )}
        </div>
      </DetailPageLayout>
    </div>
  )
}

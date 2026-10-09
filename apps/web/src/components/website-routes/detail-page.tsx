import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { getCategoryDisplayName } from '../../lib/directory/category-display'
import type { WebsiteDetailMetadata, WebsiteMetadata } from '../../lib/directory/content-query'
import { resolveListingDetailTemplate } from '../../lib/directory/listing-detail-template'
import { getCanonicalListingListRoute } from '../../lib/routing/routes'
import { generateWebsiteDetailSchema } from '../../lib/seo/schema'
import { composeMetaDescription, generateDynamicMetadata } from '../../lib/seo/seo-config'
import { siteConfig } from '../../lib/site/site-config'
import { siteCopy } from '../../lib/site/site-copy'
import { ProjectNavigation } from '../directory/project-navigation'
import { DetailPageLayout } from '../layout/detail-page-layout'
import { SectionHeader } from '../layout/section-header'
import { ListingImage } from '../listing/listing-image'
import { JsonLd } from '../seo/json-ld'
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

export function WebsiteDetailRoutePage({
  claim,
  project
}: {
  /** The claim link of a listing without an owner, while claims are on (#67). */
  claim?: ReactNode
  project: WebsiteDetailMetadata
}) {
  const detailTemplate = resolveListingDetailTemplate(project.entityType)
  const resourcesWebsite: WebsiteResourcesSectionWebsite = {
    ...(project.resourceLinks ? { resourceLinks: project.resourceLinks } : {})
  }
  const verifiedOwner = project.verifiedOwner ? { verifiedOwner: true as const } : {}

  return (
    <div data-entity-type={project.entityType || 'listing'} data-listing-template={detailTemplate}>
      <JsonLd data={generateWebsiteDetailSchema(project)} />

      {/* serplists' detail page (#273); the JSON-LD graph above carries the breadcrumb. */}
      <DetailPageLayout
        breadcrumbs={[
          { href: getCanonicalListingListRoute(), label: siteCopy.listingName.pluralTitle },
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
          category: project.category,
          ...(project.categories?.length ? { categories: project.categories } : {}),
          ...(project.isUnofficial ? { isUnofficial: true } : {}),
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
            <WebsiteContentSection website={project} />

            <WebsiteResourcesSection website={resourcesWebsite} />

            <WebsiteFaqsSection website={{ faqs: faqsToShow(project.faqs, project.content) }} />
          </div>

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

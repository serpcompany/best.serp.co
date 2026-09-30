import type { Metadata } from 'next'
import type { ComponentType, ReactNode } from 'react'
import { getCategoryDisplayName } from '../category-display'
import type {
  WebsiteDetailMetadata,
  WebsiteMetadata,
  WebsiteNavigationMetadata,
  WebsiteRelatedCardMetadata
} from '../content-query'
import { resolveListingDetailTemplate } from '../listing-detail-template'
import { getCanonicalListingListRoute, getRoute } from '../routes'
import { generateWebsiteDetailSchema } from '../schema'
import { generateDynamicMetadata } from '../seo-config'
import { siteConfig } from '../site-config'
import { siteCopy } from '../site-copy'

type JsonLdProps = {
  data: Record<string, unknown>
}

type LogoOnlyMedia = {
  media?: {
    logo?: string
  }
}

type WebsiteHeroWebsite = Pick<
  WebsiteDetailMetadata,
  'description' | 'isUnofficial' | 'name' | 'slug' | 'website'
> &
  LogoOnlyMedia

type WebsiteContentSectionProps = {
  website: WebsiteDetailMetadata
}

type WebsiteHeroProps = {
  breadcrumbItems: Array<{ href: string; name: string }>
  website: WebsiteHeroWebsite
}

type WebsiteDetailSidebarWebsite = Pick<
  WebsiteDetailMetadata,
  'category' | 'categories' | 'name' | 'publishedAt' | 'slug' | 'website'
>

type WebsiteDetailSidebarProps = {
  website: WebsiteDetailSidebarWebsite
}

type WebsiteResourcesSectionWebsite = Pick<WebsiteDetailMetadata, 'resourceLinks' | 'slug'>

type WebsiteResourcesSectionProps = {
  website: WebsiteResourcesSectionWebsite
}

type WebsiteRelatedProjectsProps = {
  websites: WebsiteRelatedCardMetadata[]
}

type ProjectNavigationProps = {
  nextWebsite: WebsiteNavigationMetadata | null
  previousWebsite: WebsiteNavigationMetadata | null
}

type ExternalResourcesSectionProps = {
  layout?: 'default' | 'compact'
  showImages?: boolean
}

type WebsiteDetailRouteSlots = {
  ExternalResourcesSection: ComponentType<ExternalResourcesSectionProps>
  JsonLd: (props: JsonLdProps) => ReactNode | Promise<ReactNode>
  ProjectNavigation: ComponentType<ProjectNavigationProps>
  WebsiteContentSection: ComponentType<WebsiteContentSectionProps>
  WebsiteDetailSidebar: ComponentType<WebsiteDetailSidebarProps>
  WebsiteHero: ComponentType<WebsiteHeroProps>
  WebsiteRelatedProjects: ComponentType<WebsiteRelatedProjectsProps>
  WebsiteResourcesSection: ComponentType<WebsiteResourcesSectionProps>
}

export async function generateWebsiteDetailRouteMetadata(
  project: WebsiteDetailMetadata
): Promise<Metadata> {
  const categoryFormatted = project.category ? getCategoryDisplayName(project.category) : null

  const seoDescription = `${project.description} Explore ${project.name} in the ${
    siteConfig.name
  } directory, with resource links, category details, and related entries.${
    categoryFormatted ? ` Category: ${categoryFormatted}.` : ''
  }`

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
    description: seoDescription.length > 160 ? project.description : seoDescription,
    slug: project.slug,
    additionalKeywords: keywords,
    publishedAt: project.publishedAt
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
  project,
  slots
}: {
  project: WebsiteDetailMetadata
  slots: WebsiteDetailRouteSlots
}) {
  const {
    ExternalResourcesSection,
    JsonLd,
    ProjectNavigation,
    WebsiteContentSection,
    WebsiteDetailSidebar,
    WebsiteHero,
    WebsiteRelatedProjects,
    WebsiteResourcesSection
  } = slots

  const breadcrumbItems = [
    {
      name: siteCopy.listingName.pluralTitle,
      href: getCanonicalListingListRoute()
    },
    {
      name: project.name,
      href: getRoute('listing.detail', { slug: project.slug })
    }
  ]
  const detailTemplate = resolveListingDetailTemplate(project.entityType)
  const logoMedia = project.media?.logo
    ? {
        logo: project.media.logo
      }
    : undefined
  const heroWebsite: WebsiteHeroWebsite = {
    slug: project.slug,
    name: project.name,
    description: project.description,
    website: project.website,
    ...(project.isUnofficial !== undefined ? { isUnofficial: project.isUnofficial } : {}),
    ...(logoMedia ? { media: logoMedia } : {})
  }
  const sidebarWebsite: WebsiteDetailSidebarWebsite = {
    slug: project.slug,
    name: project.name,
    website: project.website,
    category: project.category,
    publishedAt: project.publishedAt,
    ...(project.categories?.length ? { categories: project.categories } : {})
  }
  const resourcesWebsite: WebsiteResourcesSectionWebsite = {
    slug: project.slug,
    ...(project.resourceLinks ? { resourceLinks: project.resourceLinks } : {})
  }

  return (
    <div
      className="min-h-screen"
      data-entity-type={project.entityType || 'listing'}
      data-listing-template={detailTemplate}
    >
      <JsonLd data={generateWebsiteDetailSchema(project)} />

      <WebsiteHero website={heroWebsite} breadcrumbItems={breadcrumbItems} />

      <div className="container mx-auto px-6 py-10 md:py-14">
        <div className="max-w-6xl mx-auto">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-10">
            <div className="lg:col-span-8 space-y-14 md:space-y-16">
              <WebsiteContentSection website={project} />

              {siteConfig.features.showExternalResources && (
                <section className="animate-fade-in-up opacity-0 stagger-5">
                  <ExternalResourcesSection layout="default" showImages={false} />
                </section>
              )}

              <WebsiteResourcesSection website={resourcesWebsite} />
            </div>

            <div className="lg:col-span-4">
              <WebsiteDetailSidebar website={sidebarWebsite} />
            </div>
          </div>

          <div className="mt-14 md:mt-16 space-y-14 md:space-y-16">
            <section
              className="animate-fade-in-up opacity-0 stagger-6"
              aria-labelledby="browse-more-heading"
            >
              <div className="rounded-2xl border border-border/50 bg-card/50 backdrop-blur-sm p-6 md:p-8">
                <h2
                  id="browse-more-heading"
                  className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-4"
                >
                  Browse more
                </h2>
                <ProjectNavigation
                  previousWebsite={project.previousWebsite}
                  nextWebsite={project.nextWebsite}
                />
              </div>
            </section>

            {project.relatedWebsites?.length > 0 && (
              <WebsiteRelatedProjects websites={project.relatedWebsites} />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

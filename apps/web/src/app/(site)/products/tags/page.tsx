import { ChevronRight, Tag } from 'lucide-react'
import type { Metadata } from 'next'
import { CardGrid } from '@/components/layout/card-grid'
import { ListCard } from '@/components/layout/list-card'
import { PageHero } from '@/components/layout/page-hero'
import { PageSection } from '@/components/layout/page-shell'
import { SiteBreadcrumb } from '@/components/layout/site-breadcrumb'
import { groupByHub, HubGroupSection } from '@/components/taxonomy/hub-groups'
import { Badge } from '@/components/ui/badge'
import { getActiveCategories, getActiveTags } from '@/lib/catalog/repository'
import { getRoute } from '@/lib/routing/routes'
import { generateBaseMetadata, SITE_NAME, siteOrigin } from '@/lib/seo/seo-config'
import { linkedTags } from '@/lib/seo/taxonomy-indexing'
import { siteCopy } from '@/lib/site/site-copy'

const tagsPath = getRoute('tag.index')

// The root layout's title template adds ` | SERP`.
export async function generateMetadata(): Promise<Metadata> {
  return generateBaseMetadata({
    title: `${siteCopy.listingName.pluralTitle} by Tag`,
    description: `Browse every ${SITE_NAME} ${siteCopy.listingName.singular} tag to find curated software, AI tools, companies, and resources listed under each one.`,
    // Empty until the taxonomy is published: noindex then, and out of the pages sitemap.
    noindex: linkedTags(await getActiveTags()).length === 0,
    path: tagsPath
  })
}

/**
 * The tag index (#341, design 2.1): the tags with `TAG_LINK_MIN_LISTINGS` or more public listings,
 * grouped under their hubs, each a `ListCard` in the grid like the categories index. With no such
 * tag it shows only its heading, `noindex, follow`, and the pages sitemap leaves it out.
 */
export default async function TagsPage() {
  const [tags, categories] = await Promise.all([getActiveTags(), getActiveCategories()])
  const linked = linkedTags(tags)
  const groups = groupByHub(linked, tag => tag.category, categories)

  return (
    <>
      <PageSection spacing="hero" className="border-b">
        <SiteBreadcrumb items={[{ name: 'Tags', href: tagsPath }]} baseUrl={siteOrigin()} />
        <PageHero
          title="Tags"
          description={`${linked.length} ${linked.length === 1 ? 'tag' : 'tags'} of ${siteCopy.listingName.plural} on ${SITE_NAME}.`}
        />
      </PageSection>
      <div className="py-6">
        {groups.map(({ entries, hub }) => (
          <HubGroupSection hub={hub} key={hub.slug}>
            <CardGrid as="ul">
              {entries.map(tag => (
                <li key={tag.slug}>
                  <ListCard
                    className="h-full"
                    href={getRoute('tag.page', { tag: tag.slug })}
                    icon={<Tag />}
                    meta={
                      <>
                        <Badge variant="secondary">{tag.count}</Badge>
                        <ChevronRight aria-hidden="true" className="size-4" />
                      </>
                    }
                    title={tag.name}
                  />
                </li>
              ))}
            </CardGrid>
          </HubGroupSection>
        ))}
      </div>
    </>
  )
}

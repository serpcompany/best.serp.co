import type { Metadata } from 'next'
import { PageHero } from '@/components/layout/page-hero'
import { PageSection } from '@/components/layout/page-shell'
import { SiteBreadcrumb } from '@/components/layout/site-breadcrumb'
import { BestPageCards } from '@/components/taxonomy/best-page'
import { groupByHub, HubGroupSection } from '@/components/taxonomy/hub-groups'
import { getActiveCategories, getBestPages } from '@/lib/catalog/repository'
import { getRoute } from '@/lib/routing/routes'
import { generateBaseMetadata, SITE_NAME, siteOrigin } from '@/lib/seo/seo-config'
import { listedBestPages } from '@/lib/seo/taxonomy-indexing'
import { siteCopy } from '@/lib/site/site-copy'

const bestPath = getRoute('best.index')

// The root layout's title template adds ` | SERP`.
export async function generateMetadata(): Promise<Metadata> {
  return generateBaseMetadata({
    title: `Best ${siteCopy.listingName.singularTitle} Lists`,
    description: `Browse every ${SITE_NAME} best ${siteCopy.listingName.singular} list to find curated software, AI tools, companies, and resources for each topic.`,
    // Empty until the taxonomy is published: noindex then, and out of the pages sitemap.
    noindex: listedBestPages(await getBestPages()).length === 0,
    path: bestPath
  })
}

/**
 * The best-page index (#341, design 2.1): every best page with an entry, grouped under its hub,
 * each a `ListCard` with its entry count. With none it shows only its heading, `noindex, follow`
 * (`/products/best` 308s here), and the pages sitemap leaves it out.
 */
export default async function BestIndexPage() {
  const [bestPages, categories] = await Promise.all([getBestPages(), getActiveCategories()])
  const listed = listedBestPages(bestPages)
  const groups = groupByHub(listed, page => page.hub, categories)

  return (
    <>
      <PageSection spacing="hero" className="border-b">
        <SiteBreadcrumb items={[{ name: 'Best', href: bestPath }]} baseUrl={siteOrigin()} />
        <PageHero
          title="Best"
          description={`${listed.length} best ${siteCopy.listingName.singular} ${listed.length === 1 ? 'list' : 'lists'} on ${SITE_NAME}.`}
        />
      </PageSection>
      <div className="py-6">
        {groups.map(({ entries, hub }) => (
          <HubGroupSection hub={hub} key={hub.slug}>
            <BestPageCards pages={entries} />
          </HubGroupSection>
        ))}
      </div>
    </>
  )
}

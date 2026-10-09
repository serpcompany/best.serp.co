import { ExternalLink, Globe } from 'lucide-react'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { CardGrid } from '@/components/layout/card-grid'
import { ListCard } from '@/components/layout/list-card'
import { PageHero } from '@/components/layout/page-hero'
import { PageSection } from '@/components/layout/page-shell'
import { withDubVia } from '../../lib/analytics/dub-via'
import { getRoute } from '../../lib/routing/routes'
import { generateBaseMetadata, SITE_PUBLIC_URL, SITE_WEBSITE_ID } from '../../lib/seo/seo-config'
import type { NetworkBrandEntry } from '../../lib/site/network-brands'
import { getNetworkBrands } from '../../lib/site/network-brands'
import { generateDisabledRouteMetadata } from '../../lib/site/route-feature-gates'
import { siteConfig } from '../../lib/site/site-config'
import { siteCopy } from '../../lib/site/site-copy'

export const dynamic = 'force-static'

export function generateMetadata(): Metadata {
  if (!siteConfig.features.showBrands) {
    return generateDisabledRouteMetadata()
  }

  return generateBaseMetadata({
    title: `${siteCopy.brandsLabel} in the ${siteConfig.name} Network`,
    description: `Browse sites and products in the ${siteConfig.name} network, from directories to tools and resources, with a link to visit each one.`,
    path: getRoute('brands'),
    keywords: ['brands', 'network', siteConfig.name]
  })
}

function BrandsJsonLd({ brands }: { brands: NetworkBrandEntry[] }) {
  const brandsUrl = `${SITE_PUBLIC_URL}${getRoute('brands')}`
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: siteCopy.brandsLabel,
    description: `Browse sites and products in the ${siteConfig.name} network.`,
    url: brandsUrl,
    isPartOf: {
      '@type': 'WebSite',
      '@id': SITE_WEBSITE_ID,
      name: siteConfig.name,
      url: SITE_PUBLIC_URL
    },
    mainEntity: {
      '@type': 'ItemList',
      numberOfItems: brands.length,
      itemListElement: brands.map((brand, index) => ({
        '@type': 'ListItem',
        position: index + 1,
        item: {
          '@type': 'Organization',
          name: brand.name,
          url: brand.url
        }
      }))
    }
  }

  return (
    <script
      type="application/ld+json"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD requires unescaped JSON; content is sanitized above by escaping < to \u003c
      dangerouslySetInnerHTML={{
        __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c')
      }}
    />
  )
}

export default function BrandsPage() {
  if (!siteConfig.features.showBrands) {
    notFound()
  }

  const brands = getNetworkBrands()

  // Laid out as the categories index (#275): a hero, then each brand as a card in the grid.
  return (
    <>
      <BrandsJsonLd brands={brands} />
      <PageSection spacing="hero" className="border-b">
        <PageHero
          eyebrow="Network"
          title={siteCopy.brandsLabel}
          description={`Browse sites and products in the ${siteConfig.name} network.`}
        />
      </PageSection>
      <PageSection spacing="spacious">
        <CardGrid as="ul" aria-label={siteCopy.brandsLabel}>
          {brands.map(brand => (
            <li key={brand.slug} className="min-w-0">
              <ListCard
                // The title clips the link's own focus ring, so the card shows the stock
                // `Item` ring while its link has keyboard focus (#278 review).
                className="h-full has-[a:focus-visible]:border-ring has-[a:focus-visible]:ring-[3px] has-[a:focus-visible]:ring-ring/50"
                icon={<Globe />}
                titleAs="h2"
                title={
                  // The visible link text is the brand name (serp marketing/brands-page.md).
                  <a
                    className="inline-flex items-center gap-2 underline-offset-4 hover:underline"
                    href={withDubVia(brand.url)}
                    rel="noopener noreferrer"
                    target="_blank"
                  >
                    {brand.name}
                    <ExternalLink className="size-4 shrink-0" aria-hidden="true" />
                  </a>
                }
              />
            </li>
          ))}
        </CardGrid>
      </PageSection>
    </>
  )
}

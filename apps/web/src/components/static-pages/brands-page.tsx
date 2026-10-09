import { ExternalLink } from 'lucide-react'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { SiteCard } from '@/components/directory/site-card'
import { CardContent, CardDescription } from '@/components/ui/card'
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

  return (
    <div className="container mx-auto py-8">
      <BrandsJsonLd brands={brands} />
      <div className="space-y-10">
        <section className="space-y-3">
          <p className="text-sm font-bold uppercase tracking-wider text-muted-foreground">
            Network
          </p>
          <h1 className="text-4xl font-bold tracking-tight">{siteCopy.brandsLabel}</h1>
          <p className="max-w-3xl text-lg text-muted-foreground">
            Browse sites and products in the {siteConfig.name} network.
          </p>
        </section>

        <section
          aria-label={siteCopy.brandsLabel}
          className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
        >
          {brands.map(brand => (
            <SiteCard
              key={brand.slug}
              className="transition-all hover:border-primary hover:bg-muted/50"
            >
              <CardContent className="flex h-full flex-col gap-3 p-6">
                {/* Decorative: the brand name next to it names the link. */}
                <img
                  alt=""
                  className="size-10 shrink-0 rounded-lg object-cover"
                  decoding="async"
                  height={40}
                  loading="lazy"
                  src={brand.imageSrc}
                  width={40}
                />
                <div className="space-y-2">
                  {/* The visible link text is the brand name (serp marketing/brands-page.md). */}
                  <h2 className="text-lg font-semibold tracking-tight">
                    <a
                      className="inline-flex items-center gap-2 text-primary hover:underline"
                      href={withDubVia(brand.url)}
                      rel="noopener noreferrer"
                      target="_blank"
                    >
                      {brand.name}
                      <ExternalLink className="size-4 shrink-0" aria-hidden="true" />
                    </a>
                  </h2>
                  <CardDescription>{brand.description}</CardDescription>
                </div>
              </CardContent>
            </SiteCard>
          ))}
        </section>
      </div>
    </div>
  )
}

import { getCategoryDisplayName } from '../directory/category-display'
import { shouldUseProvidedListingLogo } from '../directory/listing-logo-presentation'
import { getCanonicalListingListRoute, getRoute } from '../routing/routes'
import { siteCopy } from '../site/site-copy'
import { SITE_NAME, siteLogoUrl, siteOrigin, siteWebsiteId } from './seo-config'

export interface SchemaOrg {
  '@context': 'https://schema.org'
  '@type': string
  [key: string]: unknown
}

/**
 * What the listed product costs, when known: `price` is a decimal amount such as `19.99` and
 * `currency` an ISO 4217 code such as `USD`. The D1 catalog records no product pricing yet
 * (serpcompany/best.serp.co#88), so catalog listings carry none and their JSON-LD makes no
 * price claim. This is not the submission plan, which is the fee a submitter pays the directory.
 */
export type ListingPricing = { model: 'free' } | { model: 'paid'; price: string; currency: string }

export interface WebsiteMetadataLike {
  category: string
  description: string
  name: string
  publishedAt: string
  /** When the listing last changed (#218); `dateModified` falls back to `publishedAt`. */
  modifiedAt?: string
  media?: {
    images?: string[]
    logo?: string
  }
  pricing?: ListingPricing
  resourceLinks?: Array<{ label: string; url: string }>
  slug: string
  website: string
}

export interface GuideMetadataLike {
  authors: Array<{ name: string; url?: string }>
  category: string
  date: string
  description: string
  difficulty: 'beginner' | 'intermediate' | 'advanced'
  publishedAt?: string
  readingTime?: number
  title: string
}

export interface WebsiteSchema extends SchemaOrg {
  '@type': 'Service'
  name: string
  description: string
  url: string
  provider: {
    '@type': 'Organization'
    name: string
    url: string
  }
  category: string
}

export interface ArticleSchema extends SchemaOrg {
  '@type': 'TechArticle'
  headline: string
  description: string
  datePublished: string
  author: {
    '@type': 'Organization'
    name: string
  }
}

export interface CollectionPageSchema extends SchemaOrg {
  '@type': 'CollectionPage'
  name: string
  description: string
  hasPart: WebsiteSchema[]
}

export interface GuideSchema extends SchemaOrg {
  '@type': 'TechArticle'
  headline: string
  description: string
  datePublished: string
  author: {
    '@type': 'Person'
    name: string
    url?: string
  }
  articleSection: string
  timeRequired: string
}

export function generateWebsiteSchema(website: WebsiteMetadataLike): WebsiteSchema {
  return {
    '@context': 'https://schema.org',
    '@type': 'Service',
    name: website.name,
    description: website.description,
    url: website.website,
    provider: {
      '@type': 'Organization',
      name: website.name,
      url: website.website
    },
    category: website.category || 'DeveloperAPI'
  }
}

export function generateArticleSchema(website: WebsiteMetadataLike): ArticleSchema {
  return {
    '@context': 'https://schema.org',
    '@type': 'TechArticle',
    headline: `${website.name} ${siteCopy.listingName.singularTitle}`,
    description: website.description,
    datePublished: website.publishedAt,
    author: {
      '@type': 'Organization',
      name: SITE_NAME
    }
  }
}

/**
 * A listing page's JSON-LD graph. Its `BreadcrumbList` follows the visible trail: Home, the
 * directory, the listing's hub when it has one (#347), then the listing.
 */
export function generateWebsiteDetailSchema(
  website: WebsiteMetadataLike,
  hub?: { name: string; slug: string }
) {
  const origin = siteOrigin()
  const pageUrl = `${origin}${getRoute('listing.detail', {
    slug: website.slug
  })}`
  const categoryFormatted = website.category
    ? getCategoryDisplayName(website.category)
    : 'Developer Tools'
  const listingLabel = siteCopy.listingName.singular
  const listingLabelTitle = siteCopy.listingName.singularTitle
  const primaryImageUrl = resolveSchemaImageUrl(website)
  const offer = resolveSchemaOffer(website.pricing)

  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebPage',
        '@id': `${pageUrl}#webpage`,
        url: pageUrl,
        name: `${website.name} ${listingLabelTitle}`,
        description: website.description,
        isPartOf: {
          '@id': siteWebsiteId()
        },
        ...(primaryImageUrl
          ? { primaryImageOfPage: { '@type': 'ImageObject', url: primaryImageUrl } }
          : {}),
        datePublished: website.publishedAt,
        dateModified: website.modifiedAt ?? website.publishedAt,
        breadcrumb: {
          '@id': `${pageUrl}#breadcrumb`
        }
      },
      {
        '@type': 'BreadcrumbList',
        '@id': `${pageUrl}#breadcrumb`,
        itemListElement: [
          {
            '@type': 'ListItem',
            position: 1,
            name: 'Home',
            item: origin
          },
          {
            '@type': 'ListItem',
            position: 2,
            name: siteCopy.allLabel,
            item: `${origin}${getCanonicalListingListRoute()}`
          },
          ...(hub
            ? [
                {
                  '@type': 'ListItem',
                  position: 3,
                  name: hub.name,
                  item: `${origin}${getRoute('category.page', { category: hub.slug })}`
                }
              ]
            : []),
          {
            '@type': 'ListItem',
            position: hub ? 4 : 3,
            name: website.name,
            item: pageUrl
          }
        ]
      },
      {
        '@type': 'SoftwareApplication',
        '@id': `${pageUrl}#software`,
        name: website.name,
        description: website.description,
        url: website.website,
        applicationCategory: categoryFormatted,
        operatingSystem: 'Web Browser',
        ...(offer ? { offers: offer } : {}),
        publisher: {
          '@type': 'Organization',
          name: website.name,
          url: website.website
        }
      },
      {
        '@type': 'TechArticle',
        '@id': `${pageUrl}#article`,
        headline: `${website.name} Overview`,
        description: `${website.description} Explore ${website.name}'s ${listingLabel}, resource links, and related context.`,
        datePublished: website.publishedAt,
        dateModified: website.modifiedAt ?? website.publishedAt,
        author: {
          '@type': 'Organization',
          name: SITE_NAME,
          url: origin
        },
        publisher: {
          '@type': 'Organization',
          name: SITE_NAME,
          url: origin,
          logo: {
            '@type': 'ImageObject',
            url: siteLogoUrl()
          }
        },
        mainEntityOfPage: {
          '@id': `${pageUrl}#webpage`
        },
        about: {
          '@id': `${pageUrl}#software`
        },
        keywords: [
          website.name,
          `${listingLabel} details`,
          'resource links',
          categoryFormatted
        ].join(', ')
      }
    ]
  }
}

/**
 * The listing's own logo as an absolute URL, or undefined when it has none. The generic
 * "no logo" fallback tile is a UI affordance, never structured data: it would tell search
 * engines that every logo-less listing shares one image, and the site logo would misattribute
 * the listing to SERP (the TechArticle publisher already carries that).
 */
function resolveSchemaImageUrl(website: WebsiteMetadataLike): string | undefined {
  const logo = website.media?.logo

  if (!shouldUseProvidedListingLogo(logo) || !logo) return undefined
  if (logo.startsWith('/')) return `${siteOrigin()}${logo}`
  return logo
}

const schemaPricePattern = /^(?:0|[1-9]\d*)(?:\.\d+)?$/u
const schemaCurrencyPattern = /^[A-Z]{3}$/u

/**
 * The SoftwareApplication offer, or undefined unless the product's pricing is known. Google
 * reads `price: '0'` as "free", so a default offer would call every paid product free. Google's
 * software app rich result needs `offers.price` and a rating or review; listings carry neither
 * rating nor review, so omitting an unknown price costs no rich result. A model other than
 * `free` or `paid`, a paid price that is not a plain positive decimal, or a currency that is not
 * three uppercase letters is omitted rather than guessed.
 */
function resolveSchemaOffer(pricing: ListingPricing | undefined) {
  if (!pricing) return undefined
  if (pricing.model === 'free') {
    return {
      '@type': 'Offer',
      price: '0',
      priceCurrency: 'USD',
      availability: 'https://schema.org/InStock'
    }
  }
  if (
    pricing.model !== 'paid' ||
    !schemaPricePattern.test(pricing.price) ||
    Number(pricing.price) <= 0 ||
    !schemaCurrencyPattern.test(pricing.currency)
  ) {
    return undefined
  }
  return {
    '@type': 'Offer',
    price: pricing.price,
    priceCurrency: pricing.currency,
    availability: 'https://schema.org/InStock'
  }
}

export function generateCollectionSchema(websites: WebsiteMetadataLike[]): CollectionPageSchema {
  return {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: `${SITE_NAME} Directory`,
    description: 'Directory of listings and resources',
    hasPart: websites.map(site => generateWebsiteSchema(site))
  }
}

export function generateGuideSchema(guide: GuideMetadataLike): GuideSchema {
  return {
    '@context': 'https://schema.org',
    '@type': 'TechArticle',
    headline: guide.title,
    description: guide.description,
    datePublished: guide.publishedAt || guide.date,
    author: {
      '@type': 'Person',
      name: guide.authors[0].name,
      ...(guide.authors[0].url && { url: guide.authors[0].url })
    },
    articleSection: guide.category,
    timeRequired: `PT${Math.ceil(guide.readingTime || 5)}M`,
    difficulty: guide.difficulty
  }
}

import { getCategoryDisplayName } from './category-display'
import {
  getListingLogoFallbackPath,
  shouldUseProvidedListingLogo
} from './listing-logo-presentation'
import { getCanonicalListingListRoute, getRoute } from './routes'
import { SITE_LOGO_URL, SITE_NAME, SITE_PUBLIC_URL, SITE_URL } from './seo-config'
import { siteCopy } from './site-copy'

export interface SchemaOrg {
  '@context': 'https://schema.org'
  '@type': string
  [key: string]: any
}

export interface WebsiteMetadataLike {
  category: string
  description: string
  name: string
  publishedAt: string
  media?: {
    images?: string[]
    logo?: string
  }
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

export function generateWebsiteDetailSchema(website: WebsiteMetadataLike) {
  const pageUrl = `${SITE_URL}${getRoute('listing.detail', {
    slug: website.slug
  })}`
  const categoryFormatted = website.category
    ? getCategoryDisplayName(website.category)
    : 'Developer Tools'
  const listingLabel = siteCopy.listingName.singular
  const listingLabelTitle = siteCopy.listingName.singularTitle
  const primaryImageUrl = resolveSchemaImageUrl(website)

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
          '@id': `${SITE_URL}/#website`
        },
        primaryImageOfPage: {
          '@type': 'ImageObject',
          url: primaryImageUrl
        },
        datePublished: website.publishedAt,
        dateModified: website.publishedAt,
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
            item: SITE_URL
          },
          {
            '@type': 'ListItem',
            position: 2,
            name: siteCopy.allLabel,
            item: `${SITE_URL}${getCanonicalListingListRoute()}`
          },
          {
            '@type': 'ListItem',
            position: 3,
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
        offers: {
          '@type': 'Offer',
          price: '0',
          priceCurrency: 'USD',
          availability: 'https://schema.org/InStock'
        },
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
        dateModified: website.publishedAt,
        author: {
          '@type': 'Organization',
          name: SITE_NAME,
          url: SITE_PUBLIC_URL
        },
        publisher: {
          '@type': 'Organization',
          name: SITE_NAME,
          url: SITE_PUBLIC_URL,
          logo: {
            '@type': 'ImageObject',
            url: SITE_LOGO_URL
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
      },
      {
        '@type': 'FAQPage',
        '@id': `${pageUrl}#faq`,
        mainEntity: [
          {
            '@type': 'Question',
            name: `What is included in ${website.name}'s ${listingLabel}?`,
            acceptedAnswer: {
              '@type': 'Answer',
              text: `${website.name}'s ${listingLabel} includes its summary, category details, primary link, and any supplemental resources included with the ${listingLabel}.`
            }
          },
          {
            '@type': 'Question',
            name: `How do I access ${website.name}'s published links?`,
            acceptedAnswer: {
              '@type': 'Answer',
              text: `You can visit ${website.name} directly at ${website.website}.${
                website.resourceLinks && website.resourceLinks.length > 0
                  ? ' This entry also includes supplemental resource links alongside the main destination.'
                  : ''
              }`
            }
          },
          {
            '@type': 'Question',
            name: `What category does ${website.name} belong to?`,
            acceptedAnswer: {
              '@type': 'Answer',
              text: `${website.name} is categorized under "${categoryFormatted}" in the ${SITE_NAME} directory. ${website.description}`
            }
          }
        ]
      }
    ]
  }
}

function resolveSchemaImageUrl(website: WebsiteMetadataLike): string {
  const logo = website.media?.logo

  if (shouldUseProvidedListingLogo(logo) && logo) {
    if (logo.startsWith('/')) return `${SITE_PUBLIC_URL}${logo}`
    return logo
  }

  return `${SITE_PUBLIC_URL}${getListingLogoFallbackPath()}`
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

import type { Metadata } from 'next'
import { type SiteRoute, siteRoutes } from '@/lib/site'
import { siteOrigin } from '../environment/site-origin'
import { getRoute } from '../routing/routes'
import {
  getConfiguredSocialLinks,
  getTwitterHandleFromUrl,
  hasConfiguredPublicSocialLinks,
  siteConfig
} from '../site/site-config'
import { siteContent } from '../site/site-content'
import { siteCopy } from '../site/site-copy'
import { absoluteUrl, canonicalPathname } from './canonical-url'

export const SITE_NAME = siteConfig.name
export const SITE_TAGLINE = siteConfig.tagline
export const SITE_DESCRIPTION = siteConfig.description

/**
 * The origin every absolute URL is written with, read per request (#359): `https://best.serp.co`,
 * or `https://staging.best.serp.co` on staging, which describes itself as production will
 * (`lib/environment/site-origin.ts`). Call these at request time, never at module load.
 */
export { siteOrigin }

/** The `@id` of the site's one `WebSite` JSON-LD node, defined on the homepage. */
export function siteWebsiteId(): string {
  return `${siteOrigin()}/#website`
}

/**
 * The canonical absolute URL of a site path. The homepage is the bare origin
 * (`https://best.serp.co`); pages end with a slash and files never do.
 */
export function siteUrl(path = '/'): string {
  return absoluteUrl(siteOrigin(), path)
}
export const SITE_TWITTER_HANDLE = hasConfiguredPublicSocialLinks(siteConfig)
  ? getTwitterHandleFromUrl(siteConfig.twitterUrl)
  : null
export function siteFaviconUrl(): string {
  return siteConfig.branding.faviconUrl ?? `${siteOrigin()}/favicon.ico`
}
export function siteAppleTouchIconUrl(): string {
  return siteConfig.branding.appleTouchIconUrl ?? `${siteOrigin()}/apple-touch-icon.png`
}
function absoluteSiteAssetUrl(url: string): string {
  return new URL(url, siteOrigin()).toString()
}

export function siteLogoUrl(): string {
  return absoluteSiteAssetUrl(siteConfig.branding.logoUrl ?? `${siteOrigin()}/placeholder.svg`)
}
export function siteOgImageUrl(): string {
  return absoluteSiteAssetUrl(siteConfig.branding.opengraphImageUrl ?? siteLogoUrl())
}
export const DIRECTORY_LISTINGS_KEYWORD = `directory ${siteCopy.listingName.plural}`

export interface OgImage {
  alt: string
  height: number
  url: string
  width: number
}

export function defaultOgImage(): OgImage {
  return {
    url: siteOgImageUrl(),
    width: 1200,
    height: 630,
    alt: `${SITE_NAME} - ${SITE_TAGLINE}`
  }
}

export const ROBOTS_CONFIG = {
  index: true,
  follow: true,
  googleBot: {
    index: true,
    follow: true,
    noimageindex: false,
    'max-video-preview': -1,
    'max-image-preview': 'large' as const,
    'max-snippet': -1
  }
}

export const KEYWORDS = {
  global: [
    DIRECTORY_LISTINGS_KEYWORD,
    'listing directory',
    'resources',
    'documentation',
    'discover'
  ],
  homepage: [SITE_NAME, DIRECTORY_LISTINGS_KEYWORD, 'listing directory', 'resources'],
  categories: {
    ai: ['AI tools', 'artificial intelligence', 'machine learning', 'neural networks'],
    'developer-tools': ['developer tools', 'programming', 'software development', 'coding tools'],
    education: ['education technology', 'e-learning', 'online courses', 'educational platforms'],
    productivity: ['productivity tools', 'workflow automation', 'task management', 'efficiency'],
    documentation: ['technical documentation', 'API docs', 'developer docs', 'knowledge base'],
    saas: ['SaaS platforms', 'cloud software', 'web applications', 'software as a service']
  }
}

/** The route registry's entry for a page path, if it lists one (`site-routes.ts`, #167). */
export function registeredRoute(path: string): SiteRoute | undefined {
  const bare = path.split(/[?#]/u)[0] || '/'
  const pathname = canonicalPathname(bare.startsWith('/') ? bare : `/${bare}`)
  return siteRoutes.find(route => route.path === pathname)
}

/**
 * Metadata for a page at `path`. For a page the route registry lists, the registry sets its
 * canonical URL and makes it noindex where it is not indexable, so the pages, the sitemaps, and
 * robots.txt cannot disagree. `noindex` still makes any page noindex: unlisted pages (sign-in,
 * account, submission steps), a feature-disabled route, the 404.
 */
export function generateBaseMetadata(options: {
  title: string
  description: string
  path?: string
  keywords?: string[]
  image?: OgImage
  noindex?: boolean
}): Metadata {
  const {
    title,
    description,
    path = '',
    keywords = KEYWORDS.global,
    image = defaultOgImage()
  } = options
  const route = path ? registeredRoute(path) : undefined
  const noindex = options.noindex === true || route?.indexable === false
  const url = siteUrl(route?.canonicalPath ?? path)
  const origin = siteOrigin()

  return {
    title,
    description,
    keywords: keywords.join(', '),
    authors: [{ name: SITE_NAME, url: origin }],
    creator: SITE_NAME,
    publisher: SITE_NAME,
    metadataBase: new URL(origin),
    alternates: {
      canonical: url
    },
    openGraph: {
      title,
      description,
      url,
      siteName: SITE_NAME,
      images: [image],
      locale: 'en_US',
      type: 'website'
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      site: SITE_TWITTER_HANDLE || undefined,
      creator: SITE_TWITTER_HANDLE || undefined,
      images: [image.url]
    },
    // Noindex pages still pass their links (header, footer, breadcrumbs) to the indexed
    // pages; `nofollow` there made every page's incoming links mixed (#151).
    robots: noindex
      ? {
          index: false,
          follow: true,
          googleBot: {
            index: false,
            follow: true
          }
        }
      : ROBOTS_CONFIG,
    verification: {
      google: process.env.NEXT_PUBLIC_GOOGLE_VERIFICATION,
      yandex: process.env.NEXT_PUBLIC_YANDEX_VERIFICATION,
      other: {
        'msvalidate.01': process.env.NEXT_PUBLIC_BING_VERIFICATION || ''
      }
    }
  }
}

/** Search results show about 60 characters of a title; past that the type suffix is dropped. */
const LISTING_TITLE_MAX_LENGTH = 60

/** `<name> - Product`, or the bare name when the suffixed title (with ` | SITE`) runs long. */
export function listingTitle(name: string): string {
  const suffixed = `${name} - ${siteCopy.listingName.singularTitle}`
  return `${suffixed} | ${SITE_NAME}`.length > LISTING_TITLE_MAX_LENGTH ? name : suffixed
}

export function generateDynamicMetadata(options: {
  type: 'website' | 'listing' | 'category' | 'member' | 'guide' | 'doc'
  name: string
  description: string
  slug: string
  additionalKeywords?: string[]
  image?: OgImage
  publishedAt?: string
  updatedAt?: string
}): Metadata {
  const {
    type,
    name,
    description,
    slug,
    additionalKeywords = [],
    image,
    publishedAt,
    updatedAt
  } = options

  let path = ''
  let title = name

  switch (type) {
    case 'website':
    case 'listing':
      path = getRoute('listing.detail', { slug })
      title = listingTitle(name)
      break
    case 'category':
      path = getRoute('category.page', { category: slug })
      title = name
      break
    case 'member':
      path = `/u/${slug}`
      title = `${name} - Community Member`
      break
    case 'guide':
      path = getRoute('guides.guide', { slug })
      title = `${name} - Developer Guide`
      break
    case 'doc':
      path = getRoute('docs.doc', { slug })
      title = `${name} - ${siteCopy.docsLabel}`
      break
  }

  const metadata = generateBaseMetadata({
    title,
    description,
    path,
    keywords: [...KEYWORDS.global, ...additionalKeywords],
    image
  })

  if ((type === 'guide' || type === 'website' || type === 'listing') && publishedAt) {
    metadata.openGraph = {
      ...metadata.openGraph,
      type: 'article',
      publishedTime: publishedAt,
      modifiedTime: updatedAt || publishedAt,
      authors: [SITE_NAME],
      section:
        type === 'website' || type === 'listing' ? siteCopy.listingName.singularTitle : undefined
    }
  }

  return metadata
}

export function generateBreadcrumbSchema(items: Array<{ name: string; url?: string }>) {
  const breadcrumbs = items.map((item, index) => ({
    '@type': 'ListItem',
    position: index + 1,
    name: item.name,
    ...(item.url ? { item: siteUrl(item.url) } : {})
  }))

  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: breadcrumbs
  }
}

export function generateWebsiteSchema() {
  const sameAs = [
    ...getConfiguredSocialLinks(siteConfig),
    ...siteContent.networkLinks.map(link => link.href)
  ]

  const origin = siteOrigin()
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    // Every page's JSON-LD points at this one node (#166).
    '@id': siteWebsiteId(),
    name: SITE_NAME,
    description: SITE_DESCRIPTION,
    url: origin,
    publisher: {
      '@type': 'Organization',
      name: SITE_NAME,
      url: origin,
      logo: {
        '@type': 'ImageObject',
        url: siteLogoUrl()
      },
      sameAs: [...new Set(sameAs)]
    }
  }
}

export function generateCollectionSchema(options: {
  name: string
  description: string
  url: string
  itemCount: number
}) {
  return {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: options.name,
    description: options.description,
    url: siteUrl(options.url),
    numberOfItems: options.itemCount,
    isPartOf: {
      '@type': 'WebSite',
      '@id': siteWebsiteId(),
      name: SITE_NAME,
      url: siteOrigin()
    }
  }
}

export {
  composeMetaDescription,
  formatPageTitle,
  generateAltText,
  optimizeMetaDescription
} from './seo-helpers'

import { type SiteRoute, siteRoutes } from '@serpdirectory/site-config'
import type { Metadata } from 'next'
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
export const SITE_PUBLIC_URL = siteConfig.publicUrl
export const SITE_URL = SITE_PUBLIC_URL
/** The `@id` of the site's one `WebSite` JSON-LD node, defined on the homepage. */
export const SITE_WEBSITE_ID = `${SITE_PUBLIC_URL}/#website`

/**
 * The canonical absolute URL of a site path. The homepage is the bare origin
 * (`https://best.serp.co`); pages end with a slash and files never do.
 */
export function siteUrl(path = '/'): string {
  return absoluteUrl(SITE_PUBLIC_URL, path)
}
export const SITE_TWITTER_HANDLE = hasConfiguredPublicSocialLinks(siteConfig)
  ? getTwitterHandleFromUrl(siteConfig.twitterUrl)
  : null
export const SITE_FAVICON_URL = siteConfig.branding.faviconUrl ?? `${SITE_URL}/favicon.ico`
export const SITE_APPLE_TOUCH_ICON_URL =
  siteConfig.branding.appleTouchIconUrl ?? `${SITE_URL}/apple-touch-icon.png`
function absoluteSiteAssetUrl(url: string): string {
  return new URL(url, SITE_URL).toString()
}

export const SITE_LOGO_URL = absoluteSiteAssetUrl(
  siteConfig.branding.logoUrl ?? `${SITE_URL}/placeholder.svg`
)
export const SITE_OG_IMAGE_URL = absoluteSiteAssetUrl(
  siteConfig.branding.opengraphImageUrl ?? SITE_LOGO_URL
)
export const DIRECTORY_LISTINGS_KEYWORD = `directory ${siteCopy.listingName.plural}`

export const DEFAULT_OG_IMAGE = {
  url: SITE_OG_IMAGE_URL,
  width: 1200,
  height: 630,
  alt: `${SITE_NAME} - ${SITE_TAGLINE}`
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
  image?: typeof DEFAULT_OG_IMAGE
  noindex?: boolean
}): Metadata {
  const {
    title,
    description,
    path = '',
    keywords = KEYWORDS.global,
    image = DEFAULT_OG_IMAGE
  } = options
  const route = path ? registeredRoute(path) : undefined
  const noindex = options.noindex === true || route?.indexable === false
  const url = siteUrl(route?.canonicalPath ?? path)

  return {
    title,
    description,
    keywords: keywords.join(', '),
    authors: [{ name: SITE_NAME, url: SITE_URL }],
    creator: SITE_NAME,
    publisher: SITE_NAME,
    metadataBase: new URL(SITE_URL),
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
  image?: typeof DEFAULT_OG_IMAGE
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

  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    // Every page's JSON-LD points at this one node (#166).
    '@id': SITE_WEBSITE_ID,
    name: SITE_NAME,
    description: SITE_DESCRIPTION,
    url: SITE_PUBLIC_URL,
    publisher: {
      '@type': 'Organization',
      name: SITE_NAME,
      url: SITE_PUBLIC_URL,
      logo: {
        '@type': 'ImageObject',
        url: SITE_LOGO_URL
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
      '@id': SITE_WEBSITE_ID,
      name: SITE_NAME,
      url: SITE_URL
    }
  }
}

export {
  composeMetaDescription,
  formatPageTitle,
  generateAltText,
  optimizeMetaDescription
} from './seo-helpers'

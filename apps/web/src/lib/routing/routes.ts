import { siteConfig } from '../site/site-config'

function normalizeBasePath(basePath: string): string {
  return basePath.replace(/^\/+|\/+$/g, '')
}

function withTrailingSlash(path: string): string {
  const [pathAndQuery = '', hash = ''] = path.split('#')
  const [pathname = '/', query = ''] = pathAndQuery.split('?')
  const suffix = `${query ? `?${query}` : ''}${hash ? `#${hash}` : ''}`
  const normalizedPathname =
    pathname === '/' || pathname.endsWith('/') || pathname.split('/').at(-1)?.includes('.')
      ? pathname
      : `${pathname}/`

  return `${normalizedPathname}${suffix}`
}

function buildRouteFromBase(basePath: string, pattern = ''): string {
  const normalizedBasePath = normalizeBasePath(basePath)
  const normalizedPattern = pattern.replace(/^\/+|\/+$/g, '')
  const routePath = `/${[normalizedBasePath, normalizedPattern].filter(Boolean).join('/')}`

  return withTrailingSlash(routePath)
}

function buildListingRoute(pattern = ''): string {
  const listingDetailSuffix = siteConfig.sitemap.listingDetailSuffix

  if (pattern === '[slug]' && listingDetailSuffix) {
    return buildRouteFromBase(siteConfig.listingRouteBasePath, `${pattern}/${listingDetailSuffix}`)
  }

  return buildRouteFromBase(siteConfig.listingRouteBasePath, pattern)
}

function buildDocsRoute(pattern = ''): string {
  return buildRouteFromBase(siteConfig.docsRouteBasePath, pattern)
}

function buildNetworkRoute(pattern = ''): string {
  return buildRouteFromBase(siteConfig.networkRouteBasePath, pattern)
}

function buildBrandsRoute(pattern = ''): string {
  return buildRouteFromBase(siteConfig.brandsRouteBasePath, pattern)
}

function buildCategoryRoute(pattern = '[category]'): string {
  const categoryBasePath = siteConfig.sitemap.categoryBasePath

  if (categoryBasePath) {
    return buildRouteFromBase(categoryBasePath, pattern)
  }

  return buildRouteFromBase('categories', pattern)
}

export const routes = {
  home: '/',
  listing: {
    list: buildListingRoute(),
    detail: buildListingRoute('[slug]'),
    featured: buildListingRoute(),
    latest: `${buildListingRoute()}?sort=latest`,
    withCategory: `${buildListingRoute()}?category=[category]`
  },
  website: {
    list: buildListingRoute(),
    detail: buildListingRoute('[slug]'),
    featured: buildListingRoute(),
    latest: `${buildListingRoute()}?sort=latest`,
    withCategory: `${buildListingRoute()}?category=[category]`
  },
  category: {
    index: buildCategoryRoute(''),
    page: buildCategoryRoute()
  },
  about: '/about/',
  account: '/account/',
  affiliateDisclosure: '/legal/affiliate-disclosure/',
  brands: buildBrandsRoute(),
  contact: '/contact/',
  favorites: '/favorites/',
  docs: {
    list: buildDocsRoute(),
    doc: buildDocsRoute('[slug]')
  },
  guides: {
    list: '/posts/',
    guide: '/posts/[slug]/'
  },
  pricing: '/pricing/',
  // The one URL per legal page; the others 308 here (apps/web/src/lib/routing/redirects.ts, #166).
  privacy: '/legal/privacy-policy/',
  cookies: '/legal/cookies/',
  dmca: '/legal/dmca/',
  projects: buildNetworkRoute(),
  search: '/search/',
  login: '/login/',
  sponsor: '/sponsor/',
  submit: '/submit/',
  terms: '/legal/terms-conditions/',
  rss: '/rss.xml'
} as const

/**
 * The directory index, `/products/`, linked from breadcrumbs and "view all". Its first page
 * renders the homepage's content, so its canonical is `/` (the route registry).
 */
export function getCanonicalListingListRoute(): string {
  return routes.listing.list
}

type StaticRoutes =
  | 'home'
  | 'account'
  | 'category.index'
  | 'listing.list'
  | 'listing.featured'
  | 'listing.latest'
  | 'website.list'
  | 'website.featured'
  | 'website.latest'
  | 'about'
  | 'docs.list'
  | 'favorites'
  | 'affiliateDisclosure'
  | 'brands'
  | 'contact'
  | 'guides.list'
  | 'pricing'
  | 'privacy'
  | 'cookies'
  | 'dmca'
  | 'login'
  | 'projects'
  | 'search'
  | 'submit'
  | 'sponsor'
  | 'terms'
  | 'rss'

type DynamicRoutes =
  | 'listing.detail'
  | 'listing.withCategory'
  | 'website.detail'
  | 'website.withCategory'
  | 'docs.doc'
  | 'guides.guide'
  | 'category.page'

type Routes = StaticRoutes | DynamicRoutes

type DynamicRouteParams = {
  'listing.detail': { slug: string }
  'listing.withCategory': { category: string }
  'website.detail': { slug: string }
  'website.withCategory': { category: string }
  'docs.doc': { slug: string }
  'guides.guide': { slug: string }
  'category.page': { category: string }
}

export function getRoute<T extends Routes>(
  route: T,
  params?: T extends keyof DynamicRouteParams ? DynamicRouteParams[T] : never
): string {
  const parts = route.split('.')
  let current: unknown = routes

  for (const part of parts) {
    current = (current as Record<string, unknown>)[part]
  }

  if (typeof current === 'string' && params) {
    const param = Object.entries(params)[0]
    return current.replace(`[${param[0]}]`, param[1])
  }

  return current as string
}

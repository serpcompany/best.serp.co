/**
 * Every source of a noindex other than the Worker's own header, evaluated from the real
 * modules: the `next.config.ts` headers() rules (compiled the way `next build` writes them to
 * the routes manifest, and matched with Next's own `has` matcher) and the metadata the root
 * layout and the directory pages export (resolved with Next's robots resolver). best.serp.co
 * must stay indexable; noindex must apply exactly where intended. Only the build-time wrappers
 * and the data and runtime modules these files import are stubbed.
 */
import { rootLayoutMetadata } from '@serpdirectory/web-core/root-shell'
import { buildCustomRoute } from 'next/dist/lib/build-custom-route'
import loadCustomRoutes from 'next/dist/lib/load-custom-routes'
import { resolveRobots } from 'next/dist/lib/metadata/resolvers/resolve-basics'
import { matchHas } from 'next/dist/shared/lib/router/utils/prepare-destination'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import * as rootLayout from '../../app/layout'
import * as homePage from '../../app/page'
import * as productsPage from '../../app/products/page'
import nextConfig from '../../next.config'

// Build-time wrappers that only add MDX and content collections; headers() is untouched.
vi.mock('@content-collections/next', () => ({
  withContentCollections: (config: unknown) => config
}))
vi.mock('@next/mdx', () => ({ default: () => (config: unknown) => config }))
// Runtime modules of the layout and pages (fonts, auth, D1); their metadata does not use them.
vi.mock('@serpdirectory/design-system/lib/fonts', () => ({ fonts: '' }))
vi.mock('@/lib/auth/header-state', () => ({ getHeaderAuthState: async () => null }))
vi.mock('@/lib/catalog/repository', () => ({ getActiveCategories: async () => [] }))
vi.mock('@/lib/environment/request-environment', () => ({
  googleTagManagerIdForRequest: async () => undefined
}))
vi.mock('@/actions/get-home-page-data', () => ({ getHomePageData: async () => null }))

interface CompiledHeaderRule {
  has?: Array<{ key?: string; type: string; value?: string }>
  headers: Array<{ key: string; value: string }>
  missing?: Array<{ key?: string; type: string; value?: string }>
  regex: string
  source: string
}

const PUBLIC_PATHS = [
  '/',
  '/about/',
  '/products/',
  '/products/autoenhance.ai/',
  '/products/categories/video-downloaders/',
  '/legal/privacy/',
  '/robots.txt',
  '/sitemap-index.xml',
  '/sitemaps/directory/1.xml',
  '/rss.xml'
]
const PLATFORM_HOSTS = [
  'best-serp-co-production.serpcompany.workers.dev',
  'best-serp-co-staging.serpcompany.workers.dev',
  '0f1e2d3c-best-serp-co-production.serpcompany.workers.dev'
]
const NOINDEX = /(?:^|[\s,:])(?:noindex|none)(?:$|[\s,])/iu

let rules: CompiledHeaderRule[] = []

beforeAll(async () => {
  const routes = await loadCustomRoutes(nextConfig as never)
  rules = routes.headers.map(rule => buildCustomRoute('header', rule) as CompiledHeaderRule)
})

/** The X-Robots-Tag values next.config.ts adds to a request for `host` and `path`. */
function configRobotsTags(host: string, path: string): string[] {
  return rules
    .filter(
      rule =>
        new RegExp(rule.regex).test(path) &&
        matchHas({ headers: { host } } as never, {}, rule.has as never, rule.missing as never)
    )
    .flatMap(rule => rule.headers)
    .filter(header => header.key.toLowerCase() === 'x-robots-tag')
    .map(header => header.value)
}

function noindexIn(robots: ReturnType<typeof resolveRobots>): boolean {
  return NOINDEX.test(robots?.basic ?? '') || NOINDEX.test(robots?.googleBot ?? '')
}

describe('next.config.ts headers()', () => {
  it('adds no noindex to any best.serp.co page or file', () => {
    expect(rules.length).toBeGreaterThan(0)
    for (const path of PUBLIC_PATHS)
      expect(
        configRobotsTags('best.serp.co', path).filter(tag => NOINDEX.test(tag)),
        path
      ).toEqual([])
  })

  it('keeps every workers.dev host and the admin preview noindex', () => {
    for (const host of PLATFORM_HOSTS)
      for (const path of PUBLIC_PATHS)
        expect(configRobotsTags(host, path), `${host}${path}`).toContain('noindex, nofollow')
    expect(configRobotsTags('best.serp.co', '/admin/submissions/1/preview/token/')).toEqual([
      'noindex, nofollow, noarchive'
    ])
  })

  it('scopes every X-Robots-Tag rule to the workers.dev hosts or the admin path', () => {
    const robotsRules = rules.filter(rule =>
      rule.headers.some(header => header.key.toLowerCase() === 'x-robots-tag')
    )
    expect(robotsRules.map(rule => rule.source).sort()).toEqual([
      '/:path*',
      '/admin/submissions/:path*'
    ])
    for (const rule of robotsRules) {
      const hostScoped = rule.has?.some(
        condition => condition.type === 'host' && condition.value === '.*\\.workers\\.dev'
      )
      expect(hostScoped || rule.source.startsWith('/admin/'), rule.source).toBe(true)
    }
  })
})

describe('exported page metadata', () => {
  it('the root layout exports the shared root metadata, with no robots directive', () => {
    expect(rootLayout.metadata).toBe(rootLayoutMetadata)
    expect(resolveRobots(rootLayout.metadata.robots)).toBeNull()
  })

  it('the homepage and the first directory page are indexable', async () => {
    expect(noindexIn(resolveRobots(homePage.metadata.robots))).toBe(false)
    const firstPage = await productsPage.generateMetadata({ searchParams: Promise.resolve({}) })
    expect(noindexIn(resolveRobots(firstPage.robots))).toBe(false)
  })

  it('only later directory pages are noindex, follow', async () => {
    const secondPage = await productsPage.generateMetadata({
      searchParams: Promise.resolve({ page: '2' })
    })
    expect(resolveRobots(secondPage.robots)).toEqual({
      basic: 'noindex, follow',
      googleBot: 'noindex, follow'
    })
  })
})

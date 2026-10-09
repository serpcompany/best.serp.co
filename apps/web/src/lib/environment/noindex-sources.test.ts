/**
 * Every source of a noindex other than the Worker's own header, evaluated from the real
 * modules: the `next.config.ts` headers() rules (compiled the way `next build` writes them to
 * the routes manifest, and matched with Next's own `has` matcher) and the metadata the root
 * layout and the directory pages export (resolved with Next's robots resolver). best.serp.co
 * must stay indexable; noindex must apply exactly where intended. Only the build-time wrappers
 * and the data and runtime modules these files import are stubbed.
 */

import { buildCustomRoute } from 'next/dist/lib/build-custom-route'
import loadCustomRoutes from 'next/dist/lib/load-custom-routes'
import { resolveRobots } from 'next/dist/lib/metadata/resolvers/resolve-basics'
import { matchHas } from 'next/dist/shared/lib/router/utils/prepare-destination'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { rootLayoutMetadata } from '@/components/layout/root-shell'
import { siteRoutes } from '@/lib/site'
import nextConfig from '../../../next.config'
import * as homePage from '../../app/(site)/page'
import * as productsPage from '../../app/(site)/products/page'
import * as rootLayout from '../../app/layout'

// Build-time wrappers that only add MDX and content collections; headers() is untouched.
vi.mock('@content-collections/next', () => ({
  withContentCollections: (config: unknown) => config
}))
vi.mock('@next/mdx', () => ({ default: () => (config: unknown) => config }))
// Runtime modules of the layout and pages (fonts, auth, D1); their metadata does not use them.
vi.mock('@/lib/fonts', () => ({ fonts: '' }))
vi.mock('@/lib/auth/header-state', () => ({ getHeaderAuthState: async () => null }))
vi.mock('@/components/auth/sign-out-button', () => ({
  useSignOut: () => [false, async () => {}]
}))
vi.mock('@/lib/catalog/repository', () => ({
  getActiveCategories: async () => []
}))
// The other registry pages' data and form modules (#167); their metadata does not use them.
vi.mock('@/lib/content-loader', () => ({
  getAboutPage: async () => null,
  getLegalContent: async () => ''
}))
vi.mock('@/components/submit/submit-form', () => ({ SubmitForm: () => null }))
vi.mock('@/lib/auth/server', () => ({ getSessionUser: async () => null }))
vi.mock('@/lib/submissions/http', () => ({ toSummary: () => null }))
vi.mock('@/lib/submissions/repository', () => ({
  getOwnSubmission: async () => null,
  insecureLogosAllowed: () => false
}))
vi.mock('@/lib/environment/request-environment', () => ({
  analyticsForRequest: async () => ({})
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
  '/legal/privacy-policy/',
  '/robots.txt',
  '/sitemap-index.xml',
  '/sitemap-products.xml',
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

  it('keeps every workers.dev host and the admin submission pages noindex', () => {
    for (const host of PLATFORM_HOSTS)
      for (const path of PUBLIC_PATHS)
        expect(configRobotsTags(host, path), `${host}${path}`).toContain('noindex, nofollow')
    expect(configRobotsTags('best.serp.co', '/admin/submissions/1/')).toEqual([
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

/** Every static page the route registry lists, by the module that renders it. */
const registryPageModules: Record<
  string,
  () => Promise<{ generateMetadata?: unknown; metadata?: unknown }>
> = {
  '/': () => import('../../app/(site)/page'),
  '/about/': () => import('../../app/(site)/about/page'),
  '/brands/': () => import('../../app/(site)/brands/page'),
  '/contact/': () => import('../../app/(site)/contact/page'),
  '/legal/': () => import('../../app/(site)/legal/page'),
  '/legal/affiliate-disclosure/': () => import('../../app/(site)/legal/affiliate-disclosure/page'),
  '/legal/cookies/': () => import('../../app/(site)/legal/cookies/page'),
  '/legal/dmca/': () => import('../../app/(site)/legal/dmca/page'),
  '/legal/privacy-policy/': () => import('../../app/(site)/legal/privacy-policy/page'),
  '/legal/terms-conditions/': () => import('../../app/(site)/legal/terms-conditions/page'),
  '/pricing/': () => import('../../app/(site)/pricing/page'),
  '/products/': () => import('../../app/(site)/products/page'),
  '/products/categories/': () => import('../../app/(site)/products/categories/page'),
  '/search/': () => import('../../app/(site)/search/page'),
  '/sponsor/': () => import('../../app/(site)/sponsor/page'),
  '/submit/': () => import('../../app/(site)/submit/page')
}

describe('the route registry and the pages (#167)', () => {
  it('maps every static registry route to its page module', () => {
    expect(Object.keys(registryPageModules).sort()).toEqual(
      siteRoutes
        .filter(route => !route.path.includes('['))
        .map(route => route.path)
        .sort()
    )
  })

  it.each(siteRoutes.filter(route => !route.path.includes('[')).map(route => [route.path, route]))(
    '%s renders the robots directive and canonical the registry gives it',
    async (path, route) => {
      const page = await registryPageModules[path]?.()
      const metadata = (
        typeof page?.generateMetadata === 'function'
          ? await page.generateMetadata({ searchParams: Promise.resolve({}) })
          : page?.metadata
      ) as { alternates?: { canonical?: unknown }; robots?: Parameters<typeof resolveRobots>[0] }
      expect(noindexIn(resolveRobots(metadata.robots)), 'noindex').toBe(!route.indexable)
      const canonical = 'canonicalPath' in route ? route.canonicalPath : path
      // A page canonical to `/` writes its tag itself (HomePageCanonicalTags): Next.js would add
      // a slash to the bare origin.
      if (canonical === '/') {
        expect(metadata.alternates?.canonical, 'canonical').toBeUndefined()
        return
      }
      expect(String(metadata.alternates?.canonical), 'canonical').toBe(
        `https://best.serp.co${canonical}`
      )
    }
  )
})

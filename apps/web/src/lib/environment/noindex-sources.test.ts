/**
 * Every source of a noindex other than the Worker's own header, evaluated from the real
 * modules: the `next.config.ts` headers() rules (compiled the way `next build` writes them to
 * the routes manifest, and matched with Next's own `has` matcher) and the metadata the root
 * layout and the directory pages export (resolved with Next's robots resolver). best.serp.co
 * must stay indexable; noindex must apply exactly where intended. Only the build-time wrappers
 * and the data and runtime modules these files import are stubbed.
 */

import { readFileSync } from 'node:fs'
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
// The taxonomy indexes are indexable once they list something (#346): one tag and one best page.
const taxonomy = vi.hoisted(() => ({
  bestPages: [{ hub: 'writing', listSize: 10, poolSize: 5, slug: 'ai-writer' }],
  tags: [{ category: 'writing', count: 3, slug: 'ai-writing' }]
}))
vi.mock('@/lib/catalog/repository', () => ({
  getActiveCategories: async () => [],
  getActiveTags: async () => taxonomy.tags,
  getBestPages: async () => taxonomy.bestPages
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

/**
 * Runs `read` as if inside a Worker request with these vars: OpenNext's request context, which
 * `lib/environment/site-origin.ts` reads synchronously.
 */
async function withWorkerEnv<T>(
  env: Record<string, string>,
  read: () => Promise<T> | T
): Promise<T> {
  const key = Symbol.for('__cloudflare-context__')
  const global = globalThis as Record<symbol, unknown>
  global[key] = { env }
  try {
    return await read()
  } finally {
    delete global[key]
  }
}

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
  '/products/tags/',
  '/products/tags/ai-chatbots/',
  '/best/',
  '/best/ai-chatbot/',
  '/legal/privacy-policy/',
  '/robots.txt',
  '/sitemap-index.xml',
  '/sitemap-products.xml',
  '/sitemap-tags.xml',
  '/sitemap-best.xml',
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

  // #323: on staging.best.serp.co the Worker adds the noindex per request, after the edge
  // cache, so Ahrefs' Site Audit can go without it; a headers() rule would be stored with the page.
  it("adds no noindex on staging's canonical host either", () => {
    for (const path of PUBLIC_PATHS)
      expect(
        configRobotsTags('staging.best.serp.co', path).filter(tag => NOINDEX.test(tag)),
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
  it('the root layout builds the shared root metadata, with no robots directive', () => {
    expect(rootLayout.generateMetadata()).toEqual(rootLayoutMetadata())
    expect(resolveRobots(rootLayout.generateMetadata().robots)).toBeNull()
  })

  it('the homepage and the first directory page are indexable', async () => {
    expect(noindexIn(resolveRobots(homePage.generateMetadata().robots))).toBe(false)
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

describe('the taxonomy indexes (#346)', () => {
  it('render noindex, follow while they list nothing, before the taxonomy is published', async () => {
    const saved = { bestPages: taxonomy.bestPages, tags: taxonomy.tags }
    try {
      taxonomy.bestPages = [{ hub: 'writing', listSize: 10, poolSize: 0, slug: 'ai-writer' }]
      taxonomy.tags = [{ category: 'writing', count: 2, slug: 'ai-writing' }]
      for (const page of [
        await import('../../app/(site)/best/page'),
        await import('../../app/(site)/products/tags/page')
      ]) {
        expect(resolveRobots((await page.generateMetadata()).robots)).toEqual({
          basic: 'noindex, follow',
          googleBot: 'noindex, follow'
        })
      }
    } finally {
      Object.assign(taxonomy, saved)
    }
  })
})

/** Every static page the route registry lists, by the module that renders it. */
const registryPageModules: Record<
  string,
  () => Promise<{ generateMetadata?: unknown; metadata?: unknown }>
> = {
  '/': () => import('../../app/(site)/page'),
  '/about/': () => import('../../app/(site)/about/page'),
  '/best/': () => import('../../app/(site)/best/page'),
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
  '/products/tags/': () => import('../../app/(site)/products/tags/page'),
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

  // #359: staging writes its own origin; best.serp.co (and local) write best.serp.co.
  it.each(
    siteRoutes
      .filter(route => !route.path.includes('['))
      .flatMap(route =>
        (['production', 'staging'] as const).map(environment => [route.path, environment, route])
      )
  )(
    '%s renders the robots directive and canonical the registry gives it (%s)',
    async (path, environment, route) => {
      const origin =
        environment === 'staging' ? 'https://staging.best.serp.co' : 'https://best.serp.co'
      const page = await registryPageModules[path]?.()
      const metadata = (await withWorkerEnv({ SITE_ENVIRONMENT: environment }, async () =>
        typeof page?.generateMetadata === 'function'
          ? await page.generateMetadata({ searchParams: Promise.resolve({}) })
          : page?.metadata
      )) as {
        alternates?: { canonical?: unknown }
        metadataBase?: unknown
        openGraph?: { url?: unknown }
        robots?: Parameters<typeof resolveRobots>[0]
      }
      expect(noindexIn(resolveRobots(metadata.robots)), 'noindex').toBe(!route.indexable)
      const canonical = 'canonicalPath' in route ? route.canonicalPath : path
      // A page canonical to `/` writes its tag itself (HomePageCanonicalTags): Next.js would add
      // a slash to the bare origin.
      if (canonical === '/') {
        expect(metadata.alternates?.canonical, 'canonical').toBeUndefined()
        return
      }
      expect(String(metadata.alternates?.canonical), 'canonical').toBe(`${origin}${canonical}`)
      if (metadata.openGraph?.url)
        expect(String(metadata.openGraph.url), 'og:url').toBe(`${origin}${canonical}`)
      if (metadata.metadataBase)
        expect(String(metadata.metadataBase), 'metadataBase').toBe(`${origin}/`)
    }
  )
})

/** The static-asset header rules (`apps/web/public/_headers`): host pattern -> headers. */
function staticAssetRules(): Map<string, string[]> {
  const rules = new Map<string, string[]>()
  let current: string[] | undefined
  const text = readFileSync(new URL('../../../public/_headers', import.meta.url), 'utf8')
  for (const line of text.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue
    if (/^\s/u.test(line)) {
      current?.push(line.trim())
      continue
    }
    current = []
    rules.set(line.trim(), current)
  }
  return rules
}

describe('static files (apps/web/public/_headers)', () => {
  // Static files are answered before the Worker, so these rules are their only crawl policy.
  it('keeps the workers.dev hosts and staging.best.serp.co noindex, and best.serp.co indexable', () => {
    expect(Object.fromEntries(staticAssetRules())).toEqual({
      'https://:worker.:account.workers.dev/*': ['X-Robots-Tag: noindex, nofollow'],
      'https://staging.best.serp.co/*': ['X-Robots-Tag: noindex, nofollow']
    })
  })
})

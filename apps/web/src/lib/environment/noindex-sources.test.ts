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
import { renderToStaticMarkup } from 'react-dom/server'
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
// The taxonomy pages and indexes (#346): a category of each kind, and tags and best pages on
// either side of their thresholds. The indexes are indexable once they list something.
const taxonomy = vi.hoisted(() => {
  const page = (slug: string, tag: string | null, poolSize: number) => ({
    category: tag ? null : 'writing',
    heading: `Best ${slug}`,
    hub: 'writing',
    intro: 'Ranked.',
    keyword: slug,
    lastModifiedAt: '2026-09-01T00:00:00.000Z',
    listSize: 10,
    order: 0,
    poolSize,
    slug,
    tag,
    title: `Best ${slug}`
  })
  const tag = (slug: string, count: number) => ({
    category: 'writing',
    count,
    description: '',
    lastModifiedAt: null,
    name: slug,
    order: 0,
    slug
  })
  return {
    bestPages: [page('ai-writer', null, 5), page('ai-chatbot', 'ai-chatbots', 40)],
    categories: [
      { count: 841, description: '', name: 'Other', order: 0, slug: 'other' },
      { count: 63, description: '', name: 'Video Downloaders', order: 1, slug: 'video-downloaders' }
    ],
    smallBestPage: page('ai-summarizer', 'ai-summaries', 4),
    tags: [tag('ai-writing', 12), tag('ai-chatbots', 40), tag('ai-summaries', 9)]
  }
})
vi.mock('server-only', () => ({}))
vi.mock('@/lib/catalog/repository', () => ({
  getActiveCategories: async () => [],
  getActiveTags: async () => taxonomy.tags,
  getBestPageBySlug: async (slug: string) =>
    [...taxonomy.bestPages, taxonomy.smallBestPage].find(page => page.slug === slug) ?? null,
  getBestPageItems: async (slug: string) => {
    const page = [...taxonomy.bestPages, taxonomy.smallBestPage].find(item => item.slug === slug)
    return Array.from({ length: page ? Math.min(page.listSize, page.poolSize) : 0 }, () => ({}))
  },
  getBestPages: async () => taxonomy.bestPages,
  getCategoryBySlug: async (slug: string) =>
    taxonomy.categories.find(category => category.slug === slug) ?? null,
  getTagBySlug: async (slug: string) => taxonomy.tags.find(tag => tag.slug === slug) ?? null
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
  it('render only their heading, noindex, follow, before the taxonomy is published', async () => {
    const saved = { bestPages: taxonomy.bestPages, tags: taxonomy.tags }
    try {
      taxonomy.bestPages = taxonomy.bestPages.map(page => ({ ...page, poolSize: 0 }))
      taxonomy.tags = taxonomy.tags.map(tag => ({ ...tag, count: 2 }))
      for (const [page, heading] of [
        [await import('../../app/(site)/best/page'), 'Best'],
        [await import('../../app/(site)/products/tags/page'), 'Tags']
      ] as const) {
        expect(resolveRobots((await page.generateMetadata()).robots)).toEqual({
          basic: 'noindex, follow',
          googleBot: 'noindex, follow'
        })
        const html = renderToStaticMarkup(await page.default())
        expect(html).toContain(`>${heading}</h1>`)
        // No "0 tags of products on SERP." count line, and no list.
        expect(html).not.toMatch(/\b0 (?:best|tags)\b/u)
        expect(html).not.toContain('<ul')
      }
    } finally {
      Object.assign(taxonomy, saved)
    }
  })
})

describe('the taxonomy pages’ robots (#346; #341 design 2.3)', () => {
  const robotsOf = async (
    load: () => Promise<{ generateMetadata: (props: never) => Promise<{ robots?: unknown }> }>,
    params: Record<string, string>
  ) =>
    resolveRobots(
      (
        await (
          await load()
        ).generateMetadata({
          params: Promise.resolve(params),
          searchParams: Promise.resolve({})
        } as never)
      ).robots as Parameters<typeof resolveRobots>[0]
    )
  const noindexFollow = { basic: 'noindex, follow', googleBot: 'noindex, follow' }
  const categoryPage = () => import('../../app/(site)/products/categories/[category]/page')
  const tagPage = () => import('../../app/(site)/products/tags/[tag]/page')
  const bestPage = () => import('../../app/(site)/best/[keyword]/page')

  it('keeps the transitional Other category noindex, follow and out of its sitemap', async () => {
    expect(await robotsOf(categoryPage, { category: 'other' })).toEqual(noindexFollow)
    expect(noindexIn(await robotsOf(categoryPage, { category: 'video-downloaders' }))).toBe(false)
    const { createTaxonomiesSitemapResponse } = await import('../seo/sitemaps')
    const sitemap = await (
      await createTaxonomiesSitemapResponse({
        getWebsites: () =>
          taxonomy.categories.map(category => ({
            category: category.slug,
            publishedAt: '2026-05-16',
            slug: `${category.slug}-listing`
          }))
      })
    ).text()
    expect(sitemap).toContain(
      '<loc>https://best.serp.co/products/categories/video-downloaders/</loc>'
    )
    expect(sitemap).not.toContain('/products/categories/other/')
  })

  it('indexes a tag from 10 listings, unless a best page ranks it alone', async () => {
    expect(noindexIn(await robotsOf(tagPage, { tag: 'ai-writing' }))).toBe(false)
    expect(await robotsOf(tagPage, { tag: 'ai-summaries' })).toEqual(noindexFollow)
    expect(await robotsOf(tagPage, { tag: 'ai-chatbots' })).toEqual(noindexFollow)
  })

  it('indexes a best page from 5 entries', async () => {
    expect(noindexIn(await robotsOf(bestPage, { keyword: 'ai-writer' }))).toBe(false)
    expect(await robotsOf(bestPage, { keyword: 'ai-summarizer' })).toEqual(noindexFollow)
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

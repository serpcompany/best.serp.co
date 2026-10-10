/**
 * #359: every absolute URL a page, sitemap or feed writes takes the environment's origin per
 * request: `https://staging.best.serp.co` on staging, which describes itself as best.serp.co
 * will, and `https://best.serp.co` everywhere else, exactly as before. Each builder runs inside a
 * stand-in for OpenNext's request context (the Worker's vars), the way a render reads it.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { paginatedMetadata } from '@/components/directory/listing-pagination'
import { HomePageCanonicalTags, homePageMetadata } from '@/components/home/home-page'
import { notFoundMetadata } from '@/components/layout/not-found-content'
import { rootLayoutMetadata } from '@/components/layout/root-shell'
import { generateWebsiteDetailSchema } from '../seo/schema'
import {
  defaultOgImage,
  generateBaseMetadata,
  generateBreadcrumbSchema,
  generateCollectionSchema,
  generateDynamicMetadata,
  generateWebsiteSchema,
  siteUrl
} from '../seo/seo-config'
import {
  createCanonicalRobots,
  createListingsSitemapResponse,
  createPagesSitemapResponse,
  createSitemapIndexResponse,
  createTaxonomiesSitemapResponse
} from '../seo/sitemaps'
import { siteOrigin } from './site-origin'

const websites = vi.hoisted(() => [
  {
    category: 'video-downloaders',
    description: 'Downloads videos.',
    modifiedAt: '2026-09-30T12:00:00.000Z',
    name: 'Autoenhance',
    publishedAt: '2026-05-16',
    slug: 'autoenhance.ai'
  }
])
vi.mock('@/lib/content-loader', () => ({ getWebsites: async () => websites }))

const CONTEXT = Symbol.for('__cloudflare-context__')
const PRODUCTION = 'https://best.serp.co'
const STAGING = 'https://staging.best.serp.co'

function runAs(env: Record<string, string> | null): void {
  const global = globalThis as Record<symbol, unknown>
  if (env) global[CONTEXT] = { env }
  else delete global[CONTEXT]
}

/** Everything a request writes, as text: metadata, JSON-LD, sitemaps, the feed, the tags. */
async function everythingWritten(): Promise<string> {
  const loaders = { getWebsites: () => websites }
  const { GET: rss } = await import('../../app/(files)/rss.xml/route')
  const base = generateBaseMetadata({ description: 'd', path: '/about/', title: 't' })
  return [
    JSON.stringify(rootLayoutMetadata()),
    JSON.stringify(base),
    JSON.stringify(homePageMetadata()),
    JSON.stringify(notFoundMetadata()),
    JSON.stringify(paginatedMetadata(base, { basePath: '/products/', page: 2 })),
    JSON.stringify(
      generateDynamicMetadata({
        description: 'd',
        name: 'Autoenhance',
        publishedAt: '2026-05-16',
        slug: 'autoenhance.ai',
        type: 'listing'
      })
    ),
    JSON.stringify(defaultOgImage()),
    JSON.stringify(generateWebsiteSchema()),
    JSON.stringify(
      generateBreadcrumbSchema([
        { name: 'Home', url: '/' },
        { name: 'About', url: '/about/' }
      ])
    ),
    JSON.stringify(
      generateCollectionSchema({ description: 'd', itemCount: 1, name: 'n', url: '/products/' })
    ),
    JSON.stringify(
      generateWebsiteDetailSchema({ ...websites[0], media: { logo: '/listing-logos/a.png' } })
    ),
    await (await createSitemapIndexResponse(loaders)).text(),
    await (await createPagesSitemapResponse(loaders)).text(),
    await (await createListingsSitemapResponse(loaders)).text(),
    await (await createTaxonomiesSitemapResponse(loaders)).text(),
    await (await rss()).text(),
    renderToStaticMarkup(<HomePageCanonicalTags />)
  ].join('\n')
}

describe("each request's origin", () => {
  beforeEach(() => {
    vi.stubGlobal('React', React)
  })

  afterEach(() => {
    runAs(null)
    vi.unstubAllGlobals()
  })

  it('reads the origin from the Worker vars of the request', () => {
    runAs({ SITE_ENVIRONMENT: 'staging' })
    expect(siteOrigin()).toBe(STAGING)
    expect(siteUrl('/')).toBe(STAGING)
    expect(siteUrl('/about')).toBe(`${STAGING}/about/`)
    runAs({ D1_RUNTIME_ENV: 'local', LOCAL_STAGING_ACCESS: 'on', SITE_ENVIRONMENT: 'local' })
    expect(siteOrigin()).toBe(STAGING)
    for (const env of [
      { SITE_ENVIRONMENT: 'production' },
      { D1_RUNTIME_ENV: 'local', SITE_ENVIRONMENT: 'local' },
      {}
    ]) {
      runAs(env)
      expect(siteOrigin(), JSON.stringify(env)).toBe(PRODUCTION)
    }
    // Outside a request (tests, the build) there is no context: production's origin.
    runAs(null)
    expect(siteOrigin()).toBe(PRODUCTION)
  })

  it("writes only staging's origin on staging, in every absolute URL", async () => {
    runAs({ SITE_ENVIRONMENT: 'staging' })
    const written = await everythingWritten()
    expect(written).toContain(`"canonical":"${STAGING}/about/"`)
    expect(written).toContain(`<loc>${STAGING}/products/autoenhance.ai/</loc>`)
    expect(written).toContain(`"home_page_url":"${STAGING}"`)
    expect(written).toContain(`"@id":"${STAGING}/#website"`)
    expect(written).toContain(`href="${STAGING}"`)
    // `https://staging.best.serp.co` does not contain `https://best.serp.co`.
    expect(written).not.toContain(PRODUCTION)
  })

  it('writes best.serp.co everywhere else, exactly as before #359', async () => {
    for (const env of [
      { SITE_ENVIRONMENT: 'production' },
      { D1_RUNTIME_ENV: 'local', SITE_ENVIRONMENT: 'local' },
      null
    ]) {
      runAs(env)
      const written = await everythingWritten()
      expect(written, JSON.stringify(env)).toContain(`"canonical":"${PRODUCTION}/about/"`)
      expect(written).toContain(`<loc>${PRODUCTION}/products/autoenhance.ai/</loc>`)
      expect(written).toContain(`"home_page_url":"${PRODUCTION}"`)
      expect(written).not.toContain('staging')
    }
  })

  it("builds the static robots.txt route, outside any request, with best.serp.co's sitemap", () => {
    // The route is prerendered at build time; the Worker answers robots.txt itself everywhere
    // but best.serp.co (`stagingRobotsTxt` on staging).
    expect(createCanonicalRobots().sitemap).toBe(`${PRODUCTION}/sitemap-index.xml`)
  })
})

/** Every TypeScript module under `dir`, tests excepted. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.tsx?$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name) ? [path] : []
  })
}

/** The module a relative or `@/` import names, or null for a package. */
function resolveImport(from: string, specifier: string, srcRoot: string): string | null {
  const base = specifier.startsWith('@/')
    ? join(srcRoot, specifier.slice(2))
    : specifier.startsWith('.')
      ? join(dirname(from), specifier)
      : null
  if (!base) return null
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx')
  ]
  return (
    candidates.find(candidate => existsSync(candidate) && !statSync(candidate).isDirectory()) ??
    null
  )
}

describe('no module computes the origin at load time', () => {
  // A top-level constant is computed once, outside any request, so one built from anything that
  // reads the origin would keep best.serp.co on staging. The functions that read it are derived,
  // not listed: every function exported by `site-origin.ts` or by a module that imports one that
  // does, transitively. `export const metadata = { title: 'Admins' }` (no call) is fine.
  it('calls nothing that reads the origin at module load', () => {
    const srcRoot = new URL('../../', import.meta.url).pathname
    const files = sourceFiles(srcRoot)
    const sources = new Map(files.map(file => [file, readFileSync(file, 'utf8')]))
    const imports = new Map(
      files.map(file => [
        file,
        [...(sources.get(file) ?? '').matchAll(/\bfrom\s+'([^']+)'/gu)]
          .map(match => resolveImport(file, match[1] ?? '', srcRoot))
          .filter((resolved): resolved is string => resolved !== null)
      ])
    )
    const readers = new Set([join(srcRoot, 'lib/environment/site-origin.ts')])
    for (let grew = true; grew; ) {
      grew = false
      for (const file of files)
        if (!readers.has(file) && imports.get(file)?.some(target => readers.has(target))) {
          readers.add(file)
          grew = true
        }
    }
    const names = new Set(
      [...readers].flatMap(file =>
        [
          ...(sources.get(file) ?? '').matchAll(
            /^export (?:async )?function (\w+)|^export const (\w+) = (?:async )?(?:\(|function)/gmu
          )
        ].map(match => match[1] ?? match[2] ?? '')
      )
    )
    // Sanity: the derivation reaches the builders the pages use.
    for (const name of ['siteUrl', 'generateBaseMetadata', 'generateWebsiteDetailSchema'])
      expect(names, name).toContain(name)
    const calls = new RegExp(`\\b(?:${[...names].join('|')})\\(`, 'u')
    const offenders = files.flatMap(file => {
      const lines = (sources.get(file) ?? '').split('\n')
      return lines.flatMap((line, index) => {
        if (!/^(?:export )?(?:const|let|var) /u.test(line)) return []
        // The whole top-level statement: up to the next line that starts at column 0.
        const end = lines.findIndex((next, at) => at > index && /^\S/u.test(next))
        const statement = lines.slice(index, end === -1 ? undefined : end).join('\n')
        return calls.test(statement) ? [`${file.slice(srcRoot.length)}:${index + 1}`] : []
      })
    })
    expect(offenders).toEqual([])
  })
})

import { describe, expect, it, vi } from 'vitest'
import { SqliteD1, seedContractFixture, seedTaxonomyFixture } from '@/db/test-support'
import { catalogLegacyRootLookup } from '@/lib/worker/catalog'
import { legacyRootRedirect, legacyRootSlugMatcher, taxonomyTargetRoute } from './legacy-root'

vi.mock('server-only', () => ({}))

// The shape `next build` writes to `.next/routes-manifest.json`, `\-` escapes included.
const manifest = {
  dynamicRoutes: [
    { page: '/products/[slug]', regex: '^/products/([^/]+?)(?:/)?$' },
    { page: '/submit/[id]', regex: '^/submit/([^/]+?)(?:/)?$' },
    { page: '/submit/[id]/checkout\\-return', regex: '^/submit/([^/]+?)/checkout\\-return(?:/)?$' }
  ],
  rewrites: {
    afterFiles: [],
    beforeFiles: [{ regex: '^/network(?:/)?$', source: '/network' }],
    // Ran after the old `[slug]` page, so a legacy slug still wins over it.
    fallback: [{ regex: '^/([^/]+?)(?:/)?$', source: '/:path' }]
  },
  staticRoutes: [
    { page: '/', regex: '^/(?:/)?$' },
    { page: '/about', regex: '^/about(?:/)?$' },
    { page: '/legal/privacy\\-policy', regex: '^/legal/privacy\\-policy(?:/)?$' },
    { page: '/robots.txt', regex: '^/robots\\.txt(?:/)?$' }
  ]
}
// A `next.config.ts` redirect, as `configRedirectPatterns` reads it from the manifest.
const configRedirects = [/^(?!\/_next)\/privacy(?:\/)?$/]
const slugFor = legacyRootSlugMatcher(manifest, configRedirects)

describe('legacy root-level URLs (#168)', () => {
  it.each([
    ['/autoenhance.ai', 'autoenhance.ai'],
    ['/autoenhance.ai/', 'autoenhance.ai'],
    ['/video-downloaders', 'video-downloaders']
  ])('reads the slug of %s', (path, slug) => {
    expect(slugFor(path)).toBe(slug)
  })

  it.each([
    '/',
    '/about',
    '/about/',
    '/robots.txt',
    '/privacy',
    '/privacy/',
    '/products/x/',
    '/network',
    '/_next',
    '/.well-known',
    '/a/b'
  ])('leaves %s to its own route', path => {
    expect(slugFor(path)).toBeNull()
  })

  it.each(['/AutoEnhance.ai', '/%E0%A4%A', '/caf%C3%A9', '/-x', `/${'a'.repeat(254)}`])(
    'never looks up %s, which cannot be a slug',
    path => {
      expect(slugFor(path)).toBeNull()
    }
  )

  it.each([
    [{}, '`staticRoutes` is not an array'],
    [{ ...manifest, dynamicRoutes: undefined }, '`dynamicRoutes` is not an array'],
    [{ ...manifest, staticRoutes: [{ page: '/' }] }, 'staticRoutes[0].regex'],
    [{ ...manifest, staticRoutes: [{ regex: '^/(' }] }, 'does not compile'],
    [{ ...manifest, rewrites: 'x' }, '`rewrites` is neither']
  ])('refuses a malformed manifest at startup (%#)', (malformed, detail) => {
    expect(() => legacyRootSlugMatcher(malformed, [])).toThrow(detail)
  })

  it('answers one 308 to the listing or category page, keeping the query', async () => {
    const lookup = vi.fn(async (slug: string) => ({
      kind: slug === 'autoenhance.ai' ? ('listing' as const) : ('category' as const),
      slug
    }))
    const listing = await legacyRootRedirect(
      new Request('https://best.serp.co/autoenhance.ai?ref=x'),
      slugFor,
      lookup
    )
    expect(listing?.status).toBe(308)
    expect(listing?.headers.get('location')).toBe('/products/autoenhance.ai/?ref=x')
    const category = await legacyRootRedirect(
      new Request('https://best.serp.co/video-downloaders/'),
      slugFor,
      lookup
    )
    expect(category?.headers.get('location')).toBe('/products/categories/video-downloaders/')
  })

  it('answers HEAD like GET', async () => {
    const lookup = vi.fn(async (slug: string) => ({ kind: 'listing' as const, slug }))
    const head = await legacyRootRedirect(
      new Request('https://best.serp.co/autoenhance.ai/', { method: 'HEAD' }),
      slugFor,
      lookup
    )
    expect(head?.status).toBe(308)
    expect(head?.headers.get('location')).toBe('/products/autoenhance.ai/')
  })

  it('answers 503, never stored, and logs when D1 fails', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failing = vi.fn(async () => {
      throw new Error('D1_ERROR: overloaded')
    })
    const response = await legacyRootRedirect(
      new Request('https://best.serp.co/autoenhance.ai'),
      slugFor,
      failing
    )
    expect(response?.status).toBe(503)
    expect(response?.headers.get('cache-control')).toBe('no-store')
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('legacy_root_lookup_failed'))
    logged.mockRestore()
  })

  it('leaves unknown slugs, other methods, and a missing catalog to Next.js', async () => {
    const none = vi.fn(async () => null)
    expect(
      await legacyRootRedirect(new Request('https://best.serp.co/missing'), slugFor, none)
    ).toBeNull()
    const lookup = vi.fn(async (slug: string) => ({ kind: 'listing' as const, slug }))
    expect(
      await legacyRootRedirect(
        new Request('https://best.serp.co/autoenhance.ai', { method: 'POST' }),
        slugFor,
        lookup
      )
    ).toBeNull()
    expect(
      await legacyRootRedirect(
        new Request('https://best.serp.co/autoenhance.ai'),
        slugFor,
        undefined
      )
    ).toBeNull()
    expect(lookup).not.toHaveBeenCalled()
  })

  it('sends a moved category URL to its target, without the query (#341)', async () => {
    const targets = {
      'old-best': { kind: 'best', slug: 'ai-chatbot' },
      'old-directory': { kind: 'directory', slug: null },
      'old-hub': { kind: 'category', slug: 'writing' },
      'old-tag': { kind: 'tag', slug: 'ai-avatar' }
    } as const
    const lookup = vi.fn(async (slug: string) => ({
      kind: 'moved' as const,
      target: targets[slug as keyof typeof targets]
    }))
    const location = async (path: string) =>
      (
        await legacyRootRedirect(new Request(`https://best.serp.co${path}`), slugFor, lookup)
      )?.headers.get('location')
    expect(await location('/old-best?page=3')).toBe('/best/ai-chatbot/')
    expect(await location('/old-directory/')).toBe('/products/')
    expect(await location('/old-hub?page=2')).toBe('/products/categories/writing/')
    expect(await location('/old-tag')).toBe('/products/tags/ai-avatar/')
    expect(taxonomyTargetRoute({ kind: 'tag', slug: 'ai-avatar' })).toBe(
      '/products/tags/ai-avatar/'
    )
  })
})

describe('root-level URLs on the Worker path, against D1 (#356)', () => {
  function workerLookup() {
    const sqlite = new SqliteD1()
    seedContractFixture(sqlite)
    seedTaxonomyFixture(sqlite)
    // #338's duplicates: `echo` is unpublished and redirects to the listing it duplicated.
    sqlite.database.exec(`
      UPDATE listings SET is_active = 0 WHERE slug = 'echo';
      INSERT INTO listing_slug_redirects (listing_id, old_slug, new_slug, manifest_id, reason)
        VALUES ('serp-charlie', 'echo', 'charlie', 'fixture', 'duplicate');
    `)
    const lookup = catalogLegacyRootLookup(
      { D1_RUNTIME_ENV: 'local', DB: sqlite.asD1Database() },
      () => {}
    )
    return { lookup, sqlite }
  }

  it('answers /<retired-slug> with one 308 straight to /products/<kept>/', async () => {
    const { lookup } = workerLookup()
    for (const path of ['/echo', '/echo/']) {
      const response = await legacyRootRedirect(
        new Request(`https://best.serp.co${path}?ref=x`),
        slugFor,
        lookup
      )
      expect(response?.status, path).toBe(308)
      expect(response?.headers.get('location'), path).toBe('/products/charlie/?ref=x')
    }
  })

  it('follows the kept listing to its current slug, and leaves a redirect to nothing to 404', async () => {
    const { lookup, sqlite } = workerLookup()
    sqlite.database.exec("UPDATE listings SET slug = 'charlie-renamed' WHERE id = 'serp-charlie'")
    const response = await legacyRootRedirect(
      new Request('https://best.serp.co/echo'),
      slugFor,
      lookup
    )
    expect(response?.headers.get('location')).toBe('/products/charlie-renamed/')
    // Once the kept listing is unpublished too, the old URL answers 404 (Next.js), not a 308.
    sqlite.database.exec("UPDATE listings SET is_active = 0 WHERE id = 'serp-charlie'")
    expect(
      await legacyRootRedirect(new Request('https://best.serp.co/echo'), slugFor, lookup)
    ).toBeNull()
  })

  it('answers a retired category URL with one 308 to its target (#341)', async () => {
    const { lookup } = workerLookup()
    const response = await legacyRootRedirect(
      new Request('https://best.serp.co/old-best/?page=2'),
      slugFor,
      lookup
    )
    expect(response?.status).toBe(308)
    expect(response?.headers.get('location')).toBe('/best/best-writers/')
  })
})

import { describe, expect, it, vi } from 'vitest'
import { legacyRootRedirect, legacyRootSlugMatcher } from './legacy-root'

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
    fallback: []
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
    const lookup = vi.fn(async (slug: string) =>
      slug === 'autoenhance.ai' ? 'listing' : 'category'
    )
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
    const lookup = vi.fn(async () => 'listing' as const)
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
    const lookup = vi.fn(async () => 'listing' as const)
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
})

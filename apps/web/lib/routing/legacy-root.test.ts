import { describe, expect, it, vi } from 'vitest'
import { legacyRootRedirect, legacyRootSlugMatcher } from './legacy-root'

// The shape `next build` writes to `.next/routes-manifest.json`.
const manifest = {
  dynamicRoutes: [
    { page: '/products/[slug]', regex: '^/products/([^/]+?)(?:/)?$' },
    { page: '/submit/[id]', regex: '^/submit/([^/]+?)(?:/)?$' }
  ],
  staticRoutes: [
    { page: '/', regex: '^/(?:/)?$' },
    { page: '/about', regex: '^/about(?:/)?$' },
    { page: '/robots.txt', regex: '^/robots\\.txt(?:/)?$' }
  ]
}
// A `next.config.ts` redirect, as `configRedirectPatterns` reads it from the manifest.
const configRedirects = [/^(?!\/_next)\/privacy(?:\/)?$/u]
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
    '/_next',
    '/a/b',
    '/%E0%A4%A'
  ])('leaves %s to its own route', path => {
    expect(slugFor(path)).toBeNull()
  })

  it('matches nothing from a manifest without route lists', () => {
    expect(legacyRootSlugMatcher({}, [])('/autoenhance.ai')).toBeNull()
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

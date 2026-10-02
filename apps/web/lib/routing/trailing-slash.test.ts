import { describe, expect, it } from 'vitest'
import { configRedirectPatterns, trailingSlashRedirect } from './trailing-slash'

/** Entries in the shape Next.js writes to `.next/routes-manifest.json` for next.config.ts. */
const manifest = {
  redirects: [
    {
      regex: '^(?!/_next)/news(?:/)?$',
      source: '/news',
      destination: '/',
      statusCode: 307
    },
    {
      regex: '^(?!/_next)/products(?:/([^/]+?))/reviews(?:/)?$',
      source: '/products/:slug/reviews',
      destination: '/products/:slug/',
      statusCode: 308
    },
    {
      regex: '^(?!/_next)/categories(?:/([^/]+?))(?:/)?$',
      source: '/categories/:category',
      destination: '/products/categories/:category/',
      statusCode: 308
    },
    {
      internal: true,
      regex: '^(?!/_next)/internal-only(?:/)?$',
      source: '/internal-only',
      destination: '/',
      statusCode: 308
    },
    {
      has: [{ type: 'host', value: 'www.best.serp.co' }],
      regex: '^(?!/_next)/conditional(?:/)?$',
      source: '/conditional',
      destination: '/',
      statusCode: 308
    }
  ]
}
const configRedirects = configRedirectPatterns(manifest)

function redirect(path: string, init?: RequestInit) {
  const response = trailingSlashRedirect(
    new Request(`https://best.serp.co${path}`, init),
    configRedirects
  )
  return response && { location: response.headers.get('location'), status: response.status }
}

describe('trailing-slash redirects', () => {
  it('sends page URLs without the slash to the slashed page', () => {
    expect(redirect('/about')).toEqual({ location: '/about/', status: 308 })
    expect(redirect('/products')).toEqual({ location: '/products/', status: 308 })
    expect(redirect('/products/autoenhance.ai')).toEqual({
      location: '/products/autoenhance.ai/',
      status: 308
    })
    expect(redirect('/docs/api')).toEqual({ location: '/docs/api/', status: 308 })
  })

  it('sends file URLs with a slash to the unslashed file', () => {
    expect(redirect('/robots.txt/')).toEqual({ location: '/robots.txt', status: 308 })
    expect(redirect('/sitemap-index.xml/')).toEqual({ location: '/sitemap-index.xml', status: 308 })
    expect(redirect('/sitemaps/pages/1.xml/')).toEqual({
      location: '/sitemaps/pages/1.xml',
      status: 308
    })
  })

  it('serves canonical URLs without a redirect', () => {
    for (const path of [
      '/',
      '/about/',
      '/products/?page=2',
      '/products/autoenhance.ai/',
      '/robots.txt',
      '/sitemap-index.xml',
      '/sitemaps/directory/1.xml'
    ]) {
      expect(redirect(path), path).toBeNull()
    }
  })

  it('never redirects /api, /.well-known, or framework paths, for any method', () => {
    for (const path of [
      '/api',
      '/api/',
      '/API',
      '/api/search?q=a',
      '/api/search/?q=a',
      '/api/submissions/1/verify/',
      '/.well-known/security.txt',
      '/.well-known/security.txt/',
      '/_next/static/chunks/app.js/'
    ]) {
      expect(redirect(path), path).toBeNull()
    }
    expect(redirect('/api/submissions', { body: '{}', method: 'POST' })).toBeNull()
    expect(redirect('/api/submissions/', { body: '{}', method: 'POST' })).toBeNull()
  })

  it('keeps the query string byte for byte', () => {
    expect(redirect('/products?page=2')).toEqual({ location: '/products/?page=2', status: 308 })
    expect(redirect('/search?q=c%23%20%2B%2B&x=a%26b&flag')).toEqual({
      location: '/search/?q=c%23%20%2B%2B&x=a%26b&flag',
      status: 308
    })
    expect(redirect('/robots.txt/?v=1')).toEqual({ location: '/robots.txt?v=1', status: 308 })
  })

  it('leaves moved URLs to their next.config.ts redirect so they resolve in one hop', () => {
    for (const path of [
      '/products/autoenhance.ai/reviews',
      '/products/autoenhance.ai/reviews/',
      '/categories/video-downloaders',
      '/categories/video-downloaders/',
      '/news'
    ]) {
      expect(redirect(path), path).toBeNull()
    }
    // OpenNext tests the patterns case-sensitively, so a different case is an ordinary page.
    expect(redirect('/Categories/video-downloaders')).toEqual({
      location: '/Categories/video-downloaders/',
      status: 308
    })
  })

  it('ignores internal and conditional config redirects', () => {
    expect(configRedirects.map(pattern => pattern.source)).toHaveLength(3)
    expect(redirect('/internal-only')).toEqual({ location: '/internal-only/', status: 308 })
    expect(redirect('/conditional')).toEqual({ location: '/conditional/', status: 308 })
    expect(configRedirectPatterns({})).toEqual([])
  })
})

import { describe, expect, it } from 'vitest'
import { absoluteUrl, canonicalPathname, isExemptPath, isFilePath } from './canonical-url'

describe('canonical URL policy', () => {
  it('adds the slash to pages, including listing slugs that are domain names', () => {
    for (const [request, canonical] of [
      ['/about', '/about/'],
      ['/about/', '/about/'],
      ['/products', '/products/'],
      ['/products/autoenhance.ai', '/products/autoenhance.ai/'],
      ['/products/autoenhance.ai/', '/products/autoenhance.ai/'],
      ['/products/aws.amazon.com', '/products/aws.amazon.com/'],
      ['/products/categories/video-downloaders', '/products/categories/video-downloaders/'],
      ['/docs/api', '/docs/api/'],
      ['/apis', '/apis/'],
      ['/about.us', '/about.us/']
    ]) {
      expect(canonicalPathname(request), request).toBe(canonical)
    }
  })

  it('removes the slash from files', () => {
    for (const [request, canonical] of [
      ['/robots.txt/', '/robots.txt'],
      ['/robots.txt', '/robots.txt'],
      ['/sitemap-index.xml/', '/sitemap-index.xml'],
      ['/sitemaps/pages/1.xml/', '/sitemaps/pages/1.xml'],
      ['/favicon.ico/', '/favicon.ico'],
      ['/badge/featured-on-serp.co-dark.svg/', '/badge/featured-on-serp.co-dark.svg'],
      ['/fonts/Inter.WOFF2/', '/fonts/Inter.WOFF2']
    ]) {
      expect(canonicalPathname(request), request).toBe(canonical)
    }
  })

  it('serves /api, /.well-known, and framework paths exactly as requested', () => {
    for (const path of [
      '/api',
      '/api/',
      '/API',
      '/Api/',
      '/api/search',
      '/api/search/',
      '/api/submissions/1/verify',
      '/api/x.json/',
      '/.well-known/security.txt',
      '/.well-known/security.txt/',
      '/.WELL-KNOWN/foo',
      '/.well-known',
      '/_next/static/chunks/main.js',
      '/_next/image'
    ]) {
      expect(isExemptPath(path), path).toBe(true)
      expect(canonicalPathname(path), path).toBe(path)
    }
    for (const path of ['/docs/api', '/apis/', '/products/api/', '/well-known/']) {
      expect(isExemptPath(path), path).toBe(false)
    }
  })

  it('leaves the homepage and paths with empty segments alone', () => {
    expect(canonicalPathname('/')).toBe('/')
    expect(canonicalPathname('//about')).toBe('//about')
    expect(canonicalPathname('/about//')).toBe('/about//')
  })

  it('recognizes files only by known extensions, never by a domain-like slug', () => {
    expect(isFilePath('/robots.txt')).toBe(true)
    expect(isFilePath('/sitemaps/directory/1.xml/')).toBe(true)
    expect(isFilePath('/opengraph-image.png')).toBe(true)
    for (const page of [
      '/',
      '/about/',
      '/products/autoenhance.ai/',
      '/products/avian.io',
      '/x.app'
    ]) {
      expect(isFilePath(page), page).toBe(false)
    }
  })

  it('writes the homepage as the bare origin and every other URL in canonical form', () => {
    const origin = 'https://best.serp.co'
    expect(absoluteUrl(origin)).toBe('https://best.serp.co')
    expect(absoluteUrl(origin, '/')).toBe('https://best.serp.co')
    expect(absoluteUrl(origin, '')).toBe('https://best.serp.co')
    expect(absoluteUrl(`${origin}/`, '/')).toBe('https://best.serp.co')
    expect(absoluteUrl(origin, '/about')).toBe('https://best.serp.co/about/')
    expect(absoluteUrl(origin, '/about/')).toBe('https://best.serp.co/about/')
    expect(absoluteUrl(origin, 'about/')).toBe('https://best.serp.co/about/')
    expect(absoluteUrl(origin, '/products/autoenhance.ai/')).toBe(
      'https://best.serp.co/products/autoenhance.ai/'
    )
    expect(absoluteUrl(origin, '/sitemap-index.xml')).toBe('https://best.serp.co/sitemap-index.xml')
    expect(absoluteUrl(origin, '/products/?page=2')).toBe('https://best.serp.co/products/?page=2')
    expect(absoluteUrl(origin, '/search?q=a')).toBe('https://best.serp.co/search/?q=a')
    expect(absoluteUrl(origin, '/api/search?q=a')).toBe('https://best.serp.co/api/search?q=a')
    // Fragments and queries name something other than the bare homepage, so they keep the path.
    expect(absoluteUrl(origin, '/#website')).toBe('https://best.serp.co/#website')
    expect(absoluteUrl(origin, '/?page=2')).toBe('https://best.serp.co/?page=2')
  })
})

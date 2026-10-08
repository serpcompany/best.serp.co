import { buildCustomRoute } from 'next/dist/lib/build-custom-route'
import { describe, expect, it } from 'vitest'
import { getRoute } from '@/lib/routing/routes'
import { canonicalPathname } from '@/lib/seo/canonical-url'
import { LEGAL_CANONICAL, movedUrlRedirects } from './redirects'
import { configRedirectPatterns, trailingSlashRedirect } from './trailing-slash'

// Compile the rules exactly as `next build` writes them to `.next/routes-manifest.json`,
// which is what OpenNext and the Worker entry read.
const rules = movedUrlRedirects()
const manifest = { redirects: rules.map(rule => buildCustomRoute('redirect', rule, ['/_next'])) }
const patterns = configRedirectPatterns(manifest)

/** A concrete request path for a rule pattern, e.g. `/products/:slug/reviews` -> `/products/x/reviews`. */
function sample(pattern: string): string {
  return pattern.replace(/:\w+[+*]?/gu, 'autoenhance.ai')
}

describe('moved-URL redirects', () => {
  it('send every moved URL to a canonical destination', () => {
    for (const rule of rules) {
      const destination = sample(rule.destination)
      expect(canonicalPathname(destination), `${rule.source} -> ${rule.destination}`).toBe(
        destination
      )
    }
  })

  it('match both slash forms of every source, so the Worker leaves them to OpenNext', () => {
    expect(patterns).toHaveLength(rules.length)
    for (const rule of rules) {
      const path = sample(rule.source)
      for (const variant of [path, `${path}/`]) {
        expect(
          patterns.some(pattern => pattern.test(variant)),
          variant
        ).toBe(true)
        expect(
          trailingSlashRedirect(new Request(`https://best.serp.co${variant}`), patterns),
          variant
        ).toBeNull()
      }
    }
  })

  it('cover the pre-D1 URL scheme', () => {
    const covered = (path: string) => patterns.some(pattern => pattern.test(path))
    for (const path of [
      '/products/autoenhance.ai/reviews',
      '/products/autoenhance.ai/reviews/',
      '/products/best/video-downloaders',
      '/products/best/video-downloaders/',
      '/products/best/featured/',
      '/categories/video-downloaders',
      '/categories/video-downloaders/',
      '/categories/',
      '/privacy',
      '/privacy/',
      '/terms',
      '/terms/',
      '/cookies',
      '/cookies/',
      '/legal/privacy',
      '/legal/privacy/',
      '/legal/terms',
      '/legal/terms/'
    ]) {
      expect(covered(path), path).toBe(true)
    }
    // Current routes are never captured by a moved-URL rule.
    for (const path of [
      '/products/',
      '/products/autoenhance.ai/',
      '/products/categories/',
      '/products/categories/video-downloaders/',
      '/about/',
      '/legal/privacy-policy/',
      '/legal/terms-conditions/',
      '/legal/cookies/'
    ]) {
      expect(covered(path), path).toBe(false)
    }
  })

  it("send every legal page's other URLs to its one canonical URL (#166)", () => {
    for (const [source, destination] of [
      ['/cookies', '/legal/cookies/'],
      ['/privacy', '/legal/privacy-policy/'],
      ['/terms', '/legal/terms-conditions/'],
      ['/legal/privacy', '/legal/privacy-policy/'],
      ['/legal/terms', '/legal/terms-conditions/']
    ]) {
      expect(
        rules.find(rule => rule.source === source),
        source
      ).toMatchObject({
        destination,
        permanent: true
      })
    }
    // The canonical URLs are the ones the routes name.
    expect(LEGAL_CANONICAL).toEqual({
      privacy: getRoute('privacy'),
      terms: getRoute('terms')
    })
  })

  it('send the old sitemap URLs to the root-level files (#167)', () => {
    for (const [source, destination] of [
      ['/sitemap.xml', '/sitemap-index.xml'],
      ['/sitemaps/pages/1.xml', '/sitemap-pages.xml'],
      ['/sitemaps/directory/1.xml', '/sitemap-products.xml'],
      ['/sitemaps/categories/1.xml', '/sitemap-categories.xml']
    ]) {
      expect(
        rules.find(rule => rule.source === source),
        source
      ).toMatchObject({ destination, permanent: true })
    }
  })

  it('no longer redirects the retired /news (the Worker answers it 410)', () => {
    expect(rules.find(rule => rule.source === '/news')).toBeUndefined()
  })

  it('give parameterized aliases a parameterless rule OpenNext can answer', () => {
    for (const rule of rules.filter(candidate => candidate.source.includes(':path'))) {
      const bare = rule.source.replace(/\/:path\+$/u, '')
      expect(
        rules.find(candidate => candidate.source === bare),
        bare
      ).toBeDefined()
      expect(rule.source).not.toMatch(/:path\*/u)
    }
  })
})

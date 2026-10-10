import { describe, expect, it } from 'vitest'
import { SMOKE_TEST_HEADER } from '../environment/site-environment'
import {
  canonicalHostRedirect,
  canonicalHostRedirectEnabled,
  canonicalHostRedirectOrigin
} from './canonical-host'

const reviewHost = 'https://best-serp-co-production.serpcompany.workers.dev'
const stagingReviewHost = 'https://best-serp-co-staging.serpcompany.workers.dev'
const on = { CANONICAL_HOST_REDIRECT: 'on', SITE_ENVIRONMENT: 'production' }
const stagingOn = { CANONICAL_HOST_REDIRECT: 'on', SITE_ENVIRONMENT: 'staging' }
/** The compiled pattern Next.js writes for `/products/:slug/reviews` (see trailing-slash.test.ts). */
const configRedirects = [/^(?!\/_next)\/products(?:\/([^/]+?))\/reviews(?:\/)?$/]

function location(url: string, env: Record<string, string> = on, init?: RequestInit) {
  const response = canonicalHostRedirect(new Request(url, init), env, configRedirects)
  if (!response) return null
  expect(response.status).toBe(308)
  return response.headers.get('location')
}

describe('canonical-host redirect', () => {
  it('is switched on only by CANONICAL_HOST_REDIRECT=on on the production or staging Worker', () => {
    expect(canonicalHostRedirectEnabled(on)).toBe(true)
    expect(canonicalHostRedirectEnabled(stagingOn)).toBe(true)
    for (const env of [
      { ...on, CANONICAL_HOST_REDIRECT: 'off' },
      { ...on, CANONICAL_HOST_REDIRECT: 'ON' },
      { ...on, CANONICAL_HOST_REDIRECT: undefined },
      { ...stagingOn, CANONICAL_HOST_REDIRECT: 'off' },
      { ...stagingOn, CANONICAL_HOST_REDIRECT: undefined },
      { ...on, SITE_ENVIRONMENT: 'local' },
      { ...on, SITE_ENVIRONMENT: 'Staging' },
      { ...on, SITE_ENVIRONMENT: undefined }
    ]) {
      expect(canonicalHostRedirectEnabled(env), JSON.stringify(env)).toBe(false)
      expect(canonicalHostRedirect(new Request(`${reviewHost}/about/`), env, [])).toBeNull()
    }
  })

  it('sends each Worker to its own canonical origin, never the other one', () => {
    expect(canonicalHostRedirectOrigin(on)).toBe('https://best.serp.co')
    expect(canonicalHostRedirectOrigin(stagingOn)).toBe('https://staging.best.serp.co')
    expect(canonicalHostRedirectOrigin({ ...on, SITE_ENVIRONMENT: 'local' })).toBeNull()
  })

  it('sends a workers.dev request to best.serp.co in one hop, in canonical form', () => {
    expect(location(`${reviewHost}/`)).toBe('https://best.serp.co/')
    expect(location(`${reviewHost}/about`)).toBe('https://best.serp.co/about/')
    expect(location(`${reviewHost}/about/`)).toBe('https://best.serp.co/about/')
    expect(location(`${reviewHost}/products/autoenhance.ai`)).toBe(
      'https://best.serp.co/products/autoenhance.ai/'
    )
    expect(location(`${reviewHost}/robots.txt/`)).toBe('https://best.serp.co/robots.txt')
    // The query string is kept byte for byte, and /api keeps its exact form.
    expect(location(`${reviewHost}/about?q=c%23%20%2B%2B&x=a%26b`)).toBe(
      'https://best.serp.co/about/?q=c%23%20%2B%2B&x=a%26b'
    )
    expect(location(`${reviewHost}/api/search?q=video`)).toBe(
      'https://best.serp.co/api/search?q=video'
    )
    expect(location(`${reviewHost}/products/?page=2`)).toBe('https://best.serp.co/products/?page=2')
    // Every method: the 308 keeps it.
    expect(location(`${reviewHost}/api/submissions`, on, { method: 'POST', body: '{}' })).toBe(
      'https://best.serp.co/api/submissions'
    )
  })

  it('covers preview URLs and leaves moved URLs to the rule on best.serp.co', () => {
    expect(location('https://0f1e2d3c-best-serp-co-production.serpcompany.workers.dev/about')).toBe(
      'https://best.serp.co/about/'
    )
    expect(location(`${reviewHost}/products/x/reviews`)).toBe(
      'https://best.serp.co/products/x/reviews'
    )
  })

  it('serves smoke-test requests and the canonical host', () => {
    expect(
      location(`${reviewHost}/about`, on, { headers: { [SMOKE_TEST_HEADER]: '1' } })
    ).toBeNull()
    expect(location('https://best.serp.co/about')).toBeNull()
    expect(location('http://127.0.0.1:8787/about')).toBeNull()
  })

  // #323: staging mirrors production on its own branded host.
  it('sends the staging workers.dev host to staging.best.serp.co the same way', () => {
    expect(location(`${stagingReviewHost}/`, stagingOn)).toBe('https://staging.best.serp.co/')
    expect(location(`${stagingReviewHost}/about?q=c%23%20%2B%2B`, stagingOn)).toBe(
      'https://staging.best.serp.co/about/?q=c%23%20%2B%2B'
    )
    expect(location(`${stagingReviewHost}/api/search?q=video`, stagingOn)).toBe(
      'https://staging.best.serp.co/api/search?q=video'
    )
    expect(location(`${stagingReviewHost}/products/x/reviews`, stagingOn)).toBe(
      'https://staging.best.serp.co/products/x/reviews'
    )
    expect(
      location(`${stagingReviewHost}/api/billing/webhook/`, stagingOn, {
        body: '{}',
        method: 'POST'
      })
    ).toBe('https://staging.best.serp.co/api/billing/webhook/')
    expect(
      location(`${stagingReviewHost}/about`, stagingOn, { headers: { [SMOKE_TEST_HEADER]: '1' } })
    ).toBeNull()
    expect(location('https://staging.best.serp.co/about', stagingOn)).toBeNull()
    expect(location('http://127.0.0.1:8787/about', stagingOn)).toBeNull()
  })
})

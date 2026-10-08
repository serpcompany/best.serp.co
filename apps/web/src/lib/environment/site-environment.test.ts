import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseRobotsTxt, robotsTxtAllows } from '../../../../../scripts/crawl-policy'
import { canonicalHostRedirectEnabled } from '../routing/canonical-host'
import {
  CANONICAL_HOST,
  isPublicProduction,
  NON_PRODUCTION_X_ROBOTS_TAG,
  nonProductionRobotsTxt,
  parseSiteEnvironment,
  SITE_ENVIRONMENT_HEADER,
  WORKER_VERSION_HEADER,
  withEnvironmentHeaders
} from './site-environment'

const request = (path: string, init?: RequestInit) =>
  new Request(`https://best-serp-co-staging.serpcompany.workers.dev${path}`, init)

describe('site environment', () => {
  it('accepts only the exact environment names', () => {
    expect(parseSiteEnvironment('production')).toBe('production')
    expect(parseSiteEnvironment('staging')).toBe('staging')
    expect(parseSiteEnvironment('local')).toBe('local')
    for (const value of [undefined, '', 'Production', 'prod', ' production', null, 1]) {
      expect(parseSiteEnvironment(value), String(value)).toBeNull()
    }
  })

  it('is public production only for the production Worker on best.serp.co', () => {
    expect(CANONICAL_HOST).toBe('best.serp.co')
    expect(isPublicProduction('production', 'best.serp.co')).toBe(true)
    expect(isPublicProduction('production', 'BEST.SERP.CO')).toBe(true)
    // The production Worker's review URL, staging, local, and missing config are not.
    expect(
      isPublicProduction('production', 'best-serp-co-production.serpcompany.workers.dev')
    ).toBe(false)
    expect(isPublicProduction('production', 'www.best.serp.co')).toBe(false)
    expect(isPublicProduction('production', 'best.serp.co.evil.example')).toBe(false)
    expect(isPublicProduction('production', null)).toBe(false)
    expect(isPublicProduction('staging', 'best.serp.co')).toBe(false)
    expect(isPublicProduction('local', 'best.serp.co')).toBe(false)
    expect(isPublicProduction(undefined, 'best.serp.co')).toBe(false)
    expect(isPublicProduction('Production', 'best.serp.co')).toBe(false)
  })

  it('answers robots.txt outside production with a file that disallows every crawler', async () => {
    const response = nonProductionRobotsTxt(request('/robots.txt'))
    expect(response?.status).toBe(200)
    expect(response?.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    if (!response) throw new Error('expected a robots.txt response')
    const groups = parseRobotsTxt(await response.text())
    for (const agent of ['*', 'googlebot', 'bingbot']) {
      expect(robotsTxtAllows(groups, agent, '/'), agent).toBe(false)
      expect(robotsTxtAllows(groups, agent, '/products/autoenhance.ai/'), agent).toBe(false)
    }
    const head = nonProductionRobotsTxt(request('/robots.txt', { method: 'HEAD' }))
    expect(head?.status).toBe(200)
    expect(head?.body).toBeNull()
    expect(nonProductionRobotsTxt(request('/robots.txt', { method: 'POST' }))).toBeNull()
    expect(nonProductionRobotsTxt(request('/robots.txt/'))).toBeNull()
    expect(nonProductionRobotsTxt(request('/sitemap-index.xml'))).toBeNull()
  })

  it('adds the Worker version and, outside production, noindex to every response', async () => {
    const page = () =>
      new Response('<html></html>', { headers: { 'content-type': 'text/html' }, status: 404 })
    const staging = withEnvironmentHeaders(page(), {
      environment: 'staging',
      publicProduction: false,
      versionId: 'v-1'
    })
    expect(staging.status).toBe(404)
    expect(await staging.text()).toBe('<html></html>')
    expect(staging.headers.get('content-type')).toBe('text/html')
    expect(staging.headers.get(WORKER_VERSION_HEADER)).toBe('v-1')
    expect(staging.headers.get(SITE_ENVIRONMENT_HEADER)).toBe('staging')
    expect(staging.headers.get('x-robots-tag')).toBe(NON_PRODUCTION_X_ROBOTS_TAG)

    const production = withEnvironmentHeaders(page(), {
      environment: 'production',
      publicProduction: true,
      versionId: 'v-1'
    })
    expect(production.headers.get('x-robots-tag')).toBeNull()
    expect(production.headers.get(WORKER_VERSION_HEADER)).toBe('v-1')
    expect(production.headers.get(SITE_ENVIRONMENT_HEADER)).toBe('production')
    const unset = withEnvironmentHeaders(page(), { environment: null, publicProduction: false })
    expect(unset.headers.has(WORKER_VERSION_HEADER)).toBe(false)
    expect(unset.headers.get(SITE_ENVIRONMENT_HEADER)).toBe('unset')

    // Redirects (immutable headers) keep their Location.
    const redirect = withEnvironmentHeaders(Response.redirect('https://best.serp.co/about/', 308), {
      environment: 'production',
      publicProduction: false
    })
    expect(redirect.status).toBe(308)
    expect(redirect.headers.get('location')).toBe('https://best.serp.co/about/')
    expect(redirect.headers.get('x-robots-tag')).toBe(NON_PRODUCTION_X_ROBOTS_TAG)
  })

  it('keeps a stricter noindex and replaces a value that would let a page be indexed', () => {
    const tagged = (value: string) =>
      withEnvironmentHeaders(new Response('x', { headers: { 'x-robots-tag': value } }), {
        environment: 'staging',
        publicProduction: false
      }).headers.get('x-robots-tag')
    expect(tagged('noindex, nofollow, noarchive')).toBe('noindex, nofollow, noarchive')
    expect(tagged('none')).toBe('none')
    expect(tagged('noarchive')).toBe(NON_PRODUCTION_X_ROBOTS_TAG)
    expect(tagged('max-image-preview: large')).toBe(NON_PRODUCTION_X_ROBOTS_TAG)
  })
})

interface WranglerEnvironment {
  preview_urls?: boolean
  vars?: Record<string, string>
  workers_dev?: boolean
}

describe('apps/web/wrangler.jsonc environment flags', () => {
  // Release tooling reads this file with JSON.parse, so it stays comment-free.
  const config = JSON.parse(
    readFileSync(new URL('../../../wrangler.jsonc', import.meta.url), 'utf8')
  ) as WranglerEnvironment & { env: Record<'production' | 'staging', WranglerEnvironment> }

  it('marks each environment explicitly, and only production as production', () => {
    expect(config.vars?.SITE_ENVIRONMENT).toBe('local')
    expect(config.env.staging.vars?.SITE_ENVIRONMENT).toBe('staging')
    expect(config.env.production.vars?.SITE_ENVIRONMENT).toBe('production')
    for (const block of [config, config.env.staging, config.env.production]) {
      expect(block.vars?.SITE_ENVIRONMENT).toBe(block.vars?.D1_RUNTIME_ENV)
    }
  })

  it('sets both platform-host switches and keeps the canonical-host switch on production', () => {
    for (const name of ['staging', 'production'] as const) {
      expect(config.env[name].workers_dev, name).toBe(true)
      expect(config.env[name].preview_urls, name).toBe(false)
    }
    // On since the cutover (deploy runbook, cutover step 5): the production workers.dev host
    // 308s to best.serp.co. Staging and local never set it, so they never redirect.
    expect(config.env.production.vars?.CANONICAL_HOST_REDIRECT).toBe('on')
    expect(config.vars?.CANONICAL_HOST_REDIRECT).toBeUndefined()
    expect(config.env.staging.vars?.CANONICAL_HOST_REDIRECT).toBeUndefined()
    expect(canonicalHostRedirectEnabled(config.env.production.vars ?? {})).toBe(true)
    expect(canonicalHostRedirectEnabled(config.env.staging.vars ?? {})).toBe(false)
    expect(canonicalHostRedirectEnabled(config.vars ?? {})).toBe(false)
  })
})

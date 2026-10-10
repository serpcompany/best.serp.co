import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseRobotsTxt, robotsTxtAllows } from '../../../../../scripts/crawl-policy'
import { project } from '../../../../../scripts/project'
import {
  canonicalHostRedirectEnabled,
  canonicalHostRedirectOrigin
} from '../routing/canonical-host'
import {
  CANONICAL_HOST,
  CANONICAL_ORIGINS,
  isPublicProduction,
  isStagingAuditRequest,
  isStagingCanonical,
  NON_PRODUCTION_X_ROBOTS_TAG,
  nonProductionRobotsTxt,
  parseSiteEnvironment,
  SITE_ENVIRONMENT_HEADER,
  STAGING_CANONICAL_HOST,
  STAGING_CANONICAL_ORIGIN,
  STAGING_CANONICAL_ROBOTS_TXT,
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

  it("names each deployed environment's canonical origin once, as scripts/project.ts does", () => {
    expect(STAGING_CANONICAL_ORIGIN).toBe('https://staging.best.serp.co')
    expect(STAGING_CANONICAL_HOST).toBe('staging.best.serp.co')
    expect(CANONICAL_ORIGINS).toEqual({
      production: 'https://best.serp.co',
      staging: 'https://staging.best.serp.co'
    })
    expect(CANONICAL_ORIGINS.production).toBe(project.remote.production.origin)
    expect(CANONICAL_ORIGINS.staging).toBe(project.remote.staging.origin)
  })

  // #323: Ahrefs' Site Audit may crawl staging's canonical host, and only that host.
  it("treats only the staging Worker on staging.best.serp.co as staging's canonical host", () => {
    expect(isStagingCanonical('staging', 'staging.best.serp.co')).toBe(true)
    expect(isStagingCanonical('staging', 'STAGING.BEST.SERP.CO')).toBe(true)
    for (const [environment, host] of [
      ['staging', 'best-serp-co-staging.serpcompany.workers.dev'],
      ['staging', 'best.serp.co'],
      ['staging', 'staging.best.serp.co.evil.example'],
      ['staging', null],
      ['production', 'staging.best.serp.co'],
      ['local', 'staging.best.serp.co'],
      [undefined, 'staging.best.serp.co']
    ] as const)
      expect(isStagingCanonical(environment, host), `${environment} ${host}`).toBe(false)
    // Staging's canonical host is never public production.
    expect(isPublicProduction('staging', 'staging.best.serp.co')).toBe(false)
  })

  it('recognizes an AhrefsSiteAudit request only on staging.best.serp.co', () => {
    const audit = (url: string, userAgent: string) =>
      new Request(url, { headers: { 'user-agent': userAgent } })
    const ahrefs =
      'Mozilla/5.0 (compatible; AhrefsSiteAudit/6.1; +http://ahrefs.com/robot/site-audit)'
    expect(isStagingAuditRequest('staging', audit('https://staging.best.serp.co/', ahrefs))).toBe(
      true
    )
    expect(
      isStagingAuditRequest('staging', audit('https://staging.best.serp.co/x', 'AHREFSSITEAUDIT'))
    ).toBe(true)
    for (const [environment, url, userAgent] of [
      ['staging', 'https://staging.best.serp.co/', 'Mozilla/5.0 (compatible; AhrefsBot/7.0)'],
      ['staging', 'https://staging.best.serp.co/', 'Googlebot'],
      ['staging', 'https://best-serp-co-staging.serpcompany.workers.dev/', ahrefs],
      ['production', 'https://best.serp.co/', ahrefs],
      ['production', 'https://staging.best.serp.co/', ahrefs],
      ['local', 'http://127.0.0.1:8787/', ahrefs]
    ] as const)
      expect(isStagingAuditRequest(environment, audit(url, userAgent)), `${url} ${userAgent}`).toBe(
        false
      )
    expect(isStagingAuditRequest('staging', new Request('https://staging.best.serp.co/'))).toBe(
      false
    )
  })

  it("serves staging's canonical robots.txt only to the robots.txt path", async () => {
    const robots = nonProductionRobotsTxt(
      new Request('https://staging.best.serp.co/robots.txt'),
      STAGING_CANONICAL_ROBOTS_TXT
    )
    if (!robots) throw new Error('expected a robots.txt response')
    const groups = parseRobotsTxt(await robots.text())
    // The reader takes lowercase agent names, as robots.txt matching is case-insensitive.
    expect(robotsTxtAllows(groups, 'ahrefssiteaudit', '/')).toBe(true)
    for (const agent of ['*', 'googlebot', 'bingbot', 'ahrefsbot'])
      expect(robotsTxtAllows(groups, agent, '/'), agent).toBe(false)
    expect(
      nonProductionRobotsTxt(
        new Request('https://staging.best.serp.co/about/'),
        STAGING_CANONICAL_ROBOTS_TXT
      )
    ).toBeNull()
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

  it("adds no noindex for a staging audit request, and keeps a page's own", () => {
    const audited = (headers: Record<string, string> = {}) =>
      withEnvironmentHeaders(new Response('x', { headers }), {
        environment: 'staging',
        publicProduction: false,
        stagingAudit: true,
        versionId: 'v-1'
      }).headers
    expect(audited().get('x-robots-tag')).toBeNull()
    expect(audited().get(SITE_ENVIRONMENT_HEADER)).toBe('staging')
    expect(audited().get(WORKER_VERSION_HEADER)).toBe('v-1')
    expect(audited({ 'x-robots-tag': 'noindex, nofollow, noarchive' }).get('x-robots-tag')).toBe(
      'noindex, nofollow, noarchive'
    )
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

  it('sets both platform-host switches and the canonical-host switch on both deployed Workers', () => {
    for (const name of ['staging', 'production'] as const) {
      expect(config.env[name].workers_dev, name).toBe(true)
      expect(config.env[name].preview_urls, name).toBe(false)
    }
    // On since the cutover (docs/PRODUCTION_CUTOVER.md, step 5): the production workers.dev host
    // 308s to best.serp.co. On for staging since #323: its workers.dev host 308s to
    // staging.best.serp.co. Local never sets it, so it never redirects.
    expect(config.env.production.vars?.CANONICAL_HOST_REDIRECT).toBe('on')
    expect(config.env.staging.vars?.CANONICAL_HOST_REDIRECT).toBe('on')
    expect(config.vars?.CANONICAL_HOST_REDIRECT).toBeUndefined()
    expect(canonicalHostRedirectEnabled(config.env.production.vars ?? {})).toBe(true)
    expect(canonicalHostRedirectOrigin(config.env.production.vars ?? {})).toBe(
      'https://best.serp.co'
    )
    expect(canonicalHostRedirectEnabled(config.env.staging.vars ?? {})).toBe(true)
    expect(canonicalHostRedirectOrigin(config.env.staging.vars ?? {})).toBe(
      'https://staging.best.serp.co'
    )
    expect(canonicalHostRedirectEnabled(config.vars ?? {})).toBe(false)
  })

  it("puts Better Auth on each deployed Worker's canonical host", () => {
    for (const name of ['staging', 'production'] as const) {
      expect(config.env[name].vars?.BETTER_AUTH_URL, name).toBe(CANONICAL_ORIGINS[name])
      expect(config.env[name].vars?.BETTER_AUTH_TRUSTED_ORIGINS, name).toBe(CANONICAL_ORIGINS[name])
    }
  })
})

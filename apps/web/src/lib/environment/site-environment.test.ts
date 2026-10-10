import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseRobotsTxt, robotsTxtAllows } from '../../../../../scripts/crawl-policy'
import { project } from '../../../../../scripts/project'
import {
  canonicalHostRedirectEnabled,
  canonicalHostRedirectOrigin
} from '../routing/canonical-host'
import { createCanonicalRobots } from '../seo/sitemaps'
import {
  CANONICAL_HOST,
  CANONICAL_ORIGIN,
  CANONICAL_ORIGINS,
  isPublicProduction,
  NON_PRODUCTION_ROBOTS_TXT,
  NON_PRODUCTION_X_ROBOTS_TAG,
  nonProductionRobotsTxt,
  parseSiteEnvironment,
  SITE_ENVIRONMENT_HEADER,
  STAGING_CANONICAL_HOST,
  STAGING_CANONICAL_ORIGIN,
  servesAsStaging,
  siteOriginFor,
  stagingRobotsTxt,
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

  // #359: a Worker that serves as staging asks for the password and writes its own origin.
  it('serves as staging only on the staging Worker, or a local Worker with the e2e switch', () => {
    expect(servesAsStaging({ SITE_ENVIRONMENT: 'staging' })).toBe(true)
    // Any host: the decision reads the Worker's vars only.
    expect(servesAsStaging({ D1_RUNTIME_ENV: 'staging', SITE_ENVIRONMENT: 'staging' })).toBe(true)
    expect(
      servesAsStaging({
        D1_RUNTIME_ENV: 'local',
        LOCAL_STAGING_ACCESS: 'on',
        SITE_ENVIRONMENT: 'local'
      })
    ).toBe(true)
    for (const env of [
      { SITE_ENVIRONMENT: 'production' },
      { LOCAL_STAGING_ACCESS: 'on', SITE_ENVIRONMENT: 'production' },
      { D1_RUNTIME_ENV: 'local', SITE_ENVIRONMENT: 'local' },
      { D1_RUNTIME_ENV: 'local', LOCAL_STAGING_ACCESS: 'ON', SITE_ENVIRONMENT: 'local' },
      // The switch is ignored unless both vars say local.
      { LOCAL_STAGING_ACCESS: 'on', SITE_ENVIRONMENT: 'local' },
      { D1_RUNTIME_ENV: 'production', LOCAL_STAGING_ACCESS: 'on', SITE_ENVIRONMENT: 'local' },
      { SITE_ENVIRONMENT: 'Staging' },
      { LOCAL_STAGING_ACCESS: 'on' },
      {},
      null,
      undefined
    ])
      expect(servesAsStaging(env), JSON.stringify(env)).toBe(false)
  })

  it("writes staging's own origin only on a Worker that serves as staging", () => {
    expect(siteOriginFor({ SITE_ENVIRONMENT: 'staging' })).toBe('https://staging.best.serp.co')
    expect(
      siteOriginFor({
        D1_RUNTIME_ENV: 'local',
        LOCAL_STAGING_ACCESS: 'on',
        SITE_ENVIRONMENT: 'local'
      })
    ).toBe(STAGING_CANONICAL_ORIGIN)
    // Production, local, and a missing or misspelled environment write best.serp.co, as before.
    for (const env of [
      { SITE_ENVIRONMENT: 'production' },
      { D1_RUNTIME_ENV: 'local', SITE_ENVIRONMENT: 'local' },
      { SITE_ENVIRONMENT: 'Staging' },
      {},
      undefined
    ])
      expect(siteOriginFor(env), JSON.stringify(env)).toBe('https://best.serp.co')
    expect(CANONICAL_ORIGIN).toBe('https://best.serp.co')
  })

  it("gives staging's auditor best.serp.co's robots rules, and every other crawler none", () => {
    const text = stagingRobotsTxt()
    expect(text).toBe(
      'User-agent: *\nDisallow: /\n\nUser-agent: AhrefsSiteAudit\nAllow: /\nDisallow: /search\nDisallow: /submit\n\nSitemap: https://staging.best.serp.co/sitemap-index.xml\n'
    )
    const groups = parseRobotsTxt(text)
    for (const agent of ['*', 'googlebot', 'bingbot', 'ahrefsbot'])
      expect(robotsTxtAllows(groups, agent, '/'), agent).toBe(false)
    // The auditor's group is exactly production's (the robots.txt route's) rules.
    const production = createCanonicalRobots().rules
    const rules = Array.isArray(production) ? production[0] : production
    const auditor = groups.find(group => group.agents.includes('ahrefssiteaudit'))
    expect(auditor?.rules).toEqual([
      ...[rules?.allow ?? []].flat().map(path => ({ allow: true, pattern: path })),
      ...[rules?.disallow ?? []].flat().map(path => ({ allow: false, pattern: path }))
    ])
    expect(robotsTxtAllows(groups, 'ahrefssiteaudit', '/products/autoenhance.ai/')).toBe(true)
    expect(robotsTxtAllows(groups, 'ahrefssiteaudit', '/search/')).toBe(false)
    expect(robotsTxtAllows(groups, 'ahrefssiteaudit', '/submit/')).toBe(false)
    const robots = nonProductionRobotsTxt(
      new Request('https://staging.best.serp.co/robots.txt'),
      text
    )
    expect(robots?.status).toBe(200)
    expect(
      nonProductionRobotsTxt(new Request('https://staging.best.serp.co/about/'), text)
    ).toBeNull()
    expect(NON_PRODUCTION_ROBOTS_TXT).toBe('User-agent: *\nDisallow: /\n')
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

  it("adds no noindex for a request that passed staging's password, and keeps a page's own", () => {
    const audited = (headers: Record<string, string> = {}) =>
      withEnvironmentHeaders(new Response('x', { headers }), {
        environment: 'staging',
        passedStagingGate: true,
        publicProduction: false,
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
    // On since the cutover (docs/production-cutover.md, step 5): the production workers.dev host
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

  // #359: the owner's decision: a plain var, shared by SERP sites, not a secret.
  it("gives only staging its password, as a var, so only staging's Worker asks for it", () => {
    expect(config.env.staging.vars?.STAGING_BASIC_AUTH_PASSWORD).toBe('stagingpassword')
    expect(config.env.production.vars?.STAGING_BASIC_AUTH_PASSWORD).toBeUndefined()
    expect(config.vars?.STAGING_BASIC_AUTH_PASSWORD).toBeUndefined()
    expect(servesAsStaging(config.env.staging.vars)).toBe(true)
    expect(servesAsStaging(config.env.production.vars)).toBe(false)
    expect(servesAsStaging(config.vars)).toBe(false)
    for (const block of [config, config.env.staging, config.env.production])
      expect(block.vars?.LOCAL_STAGING_ACCESS).toBeUndefined()
  })

  it("puts Better Auth on each deployed Worker's canonical host", () => {
    for (const name of ['staging', 'production'] as const) {
      expect(config.env[name].vars?.BETTER_AUTH_URL, name).toBe(CANONICAL_ORIGINS[name])
      expect(config.env[name].vars?.BETTER_AUTH_TRUSTED_ORIGINS, name).toBe(CANONICAL_ORIGINS[name])
    }
  })
})

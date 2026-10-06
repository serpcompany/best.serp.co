import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  type AuthEnv,
  isAuthConfigurationError,
  LOCAL_TRUSTED_ORIGINS,
  resolveAuthSettings
} from './settings'

const SECRET = 's'.repeat(48)
const STAGING_ORIGIN = 'https://best-serp-co-staging.serpcompany.workers.dev'

function expectConfigurationError(env: AuthEnv, message: RegExp): void {
  let caught: unknown
  try {
    resolveAuthSettings(env)
  } catch (error) {
    caught = error
  }
  expect(isAuthConfigurationError(caught)).toBe(true)
  expect((caught as Error).message).toMatch(message)
}

interface WranglerBlock {
  vars?: Record<string, string>
}

describe('Better Auth settings', () => {
  it('pins the per-environment base URL and trusted origins in wrangler.jsonc', () => {
    const config = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../../wrangler.jsonc'), 'utf8')
    ) as WranglerBlock & { env: { production: WranglerBlock; staging: WranglerBlock } }
    expect(config.vars?.BETTER_AUTH_URL).toBeUndefined()
    expect(config.env.staging.vars?.BETTER_AUTH_URL).toBe(STAGING_ORIGIN)
    expect(config.env.staging.vars?.BETTER_AUTH_TRUSTED_ORIGINS).toBe(STAGING_ORIGIN)
    expect(config.env.production.vars?.BETTER_AUTH_URL).toBe('https://best.serp.co')
    expect(config.env.production.vars?.BETTER_AUTH_TRUSTED_ORIGINS).toBe('https://best.serp.co')
    for (const block of [config, config.env.staging, config.env.production]) {
      // The secret is a Worker secret, never a var.
      expect(block.vars?.BETTER_AUTH_SECRET).toBeUndefined()
    }

    const staging = resolveAuthSettings({ ...config.env.staging.vars, BETTER_AUTH_SECRET: SECRET })
    expect(staging).toMatchObject({
      baseURL: STAGING_ORIGIN,
      environment: 'staging',
      trustedOrigins: [STAGING_ORIGIN],
      useSecureCookies: true
    })
    const production = resolveAuthSettings({
      ...config.env.production.vars,
      BETTER_AUTH_SECRET: SECRET
    })
    expect(production).toMatchObject({
      baseURL: 'https://best.serp.co',
      environment: 'production',
      trustedOrigins: ['https://best.serp.co'],
      useSecureCookies: true
    })
  })

  it('serves localhost on any port locally, with or without .dev.vars', () => {
    const configured = resolveAuthSettings({
      BETTER_AUTH_SECRET: SECRET,
      D1_RUNTIME_ENV: 'local',
      SITE_ENVIRONMENT: 'local'
    })
    expect(configured).toMatchObject({
      baseURL: { protocol: 'http' },
      secret: SECRET,
      secretSource: 'configured',
      trustedOrigins: LOCAL_TRUSTED_ORIGINS,
      useSecureCookies: false
    })
    const ephemeral = resolveAuthSettings({ D1_RUNTIME_ENV: 'local', SITE_ENVIRONMENT: 'local' })
    expect(ephemeral.secretSource).toBe('ephemeral')
    expect(ephemeral.secret).toMatch(/^[a-f0-9]{64}$/u)
    // One ephemeral secret per isolate, so sessions survive between requests.
    expect(resolveAuthSettings({ D1_RUNTIME_ENV: 'local', SITE_ENVIRONMENT: 'local' }).secret).toBe(
      ephemeral.secret
    )
  })

  it('shares the ephemeral secret between copies of the module in one isolate', async () => {
    // Turbopack copies this module into several route chunks; each copy must agree.
    const first = resolveAuthSettings({ D1_RUNTIME_ENV: 'local', SITE_ENVIRONMENT: 'local' })
    vi.resetModules()
    const copy = await import('./settings')
    expect(
      copy.resolveAuthSettings({ D1_RUNTIME_ENV: 'local', SITE_ENVIRONMENT: 'local' }).secret
    ).toBe(first.secret)
  })

  it('fails closed on staging and production without a secret or an https origin', () => {
    const staging = {
      BETTER_AUTH_URL: STAGING_ORIGIN,
      D1_RUNTIME_ENV: 'staging',
      SITE_ENVIRONMENT: 'staging'
    }
    expectConfigurationError(staging, /BETTER_AUTH_SECRET/u)
    expectConfigurationError({ ...staging, BETTER_AUTH_SECRET: 'short' }, /BETTER_AUTH_SECRET/u)
    expectConfigurationError(
      { ...staging, BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: undefined },
      /BETTER_AUTH_URL/u
    )
    expectConfigurationError(
      { ...staging, BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: 'http://insecure.example' },
      /BETTER_AUTH_URL/u
    )
    expectConfigurationError(
      { ...staging, BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: `${STAGING_ORIGIN}/path` },
      /BETTER_AUTH_URL/u
    )
    expectConfigurationError(
      { ...staging, BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_TRUSTED_ORIGINS: 'http://evil.test' },
      /BETTER_AUTH_TRUSTED_ORIGINS/u
    )
    // A short local secret is a mistake, not a request for the ephemeral one.
    expectConfigurationError(
      { BETTER_AUTH_SECRET: 'short', D1_RUNTIME_ENV: 'local', SITE_ENVIRONMENT: 'local' },
      /BETTER_AUTH_SECRET/u
    )
  })

  it('requires matching SITE_ENVIRONMENT and D1_RUNTIME_ENV', () => {
    expectConfigurationError({ BETTER_AUTH_SECRET: SECRET }, /SITE_ENVIRONMENT/u)
    expectConfigurationError(
      { BETTER_AUTH_SECRET: SECRET, D1_RUNTIME_ENV: 'local', SITE_ENVIRONMENT: 'production' },
      /SITE_ENVIRONMENT/u
    )
    expectConfigurationError(
      { BETTER_AUTH_SECRET: SECRET, D1_RUNTIME_ENV: 'Production', SITE_ENVIRONMENT: 'Production' },
      /SITE_ENVIRONMENT/u
    )
  })
})

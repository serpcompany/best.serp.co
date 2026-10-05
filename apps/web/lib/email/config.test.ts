import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { project } from '../../../../scripts/project'
import {
  EMAIL_DASHBOARD_PATH,
  EMAIL_LINK_ORIGINS,
  EmailConfigError,
  emailSender,
  normalizeEmailAddress,
  parseRecipientAllowlist,
  prefixedSubject,
  recipientAllowed,
  resolveEmailPolicy,
  resolveUseSendConfig,
  STAGING_ALLOWLIST_VAR,
  USESEND_API_KEY_SECRET,
  USESEND_BASE_URL_VAR
} from './config'

describe('email environment policy', () => {
  it('logs locally, prefixes and allowlists staging, and sends normally in production', () => {
    const local = resolveEmailPolicy({ D1_RUNTIME_ENV: 'local', SITE_ENVIRONMENT: 'local' })
    expect(local).toEqual({
      delivery: 'log',
      environment: 'local',
      from: { email: 'noreply@mail-staging.serp.co', name: 'SERP Directory' },
      linkOrigin: 'http://localhost:8787',
      recipientAllowlist: null,
      subjectPrefix: null
    })

    const staging = resolveEmailPolicy({
      D1_RUNTIME_ENV: 'staging',
      EMAIL_STAGING_ALLOWLIST: 'Owner@Serp.co, tester@example.com',
      SITE_ENVIRONMENT: 'staging'
    })
    expect(staging.delivery).toBe('provider')
    expect(staging.linkOrigin).toBe('https://best-serp-co-staging.serpcompany.workers.dev')
    expect(prefixedSubject(staging, 'Hello')).toBe('[staging] Hello')
    expect(recipientAllowed(staging, 'owner@serp.co')).toBe(true)
    expect(recipientAllowed(staging, 'tester@example.com')).toBe(true)
    expect(recipientAllowed(staging, 'someone@example.com')).toBe(false)

    const production = resolveEmailPolicy({
      D1_RUNTIME_ENV: 'production',
      // Ignored outside staging.
      EMAIL_STAGING_ALLOWLIST: 'owner@serp.co',
      SITE_ENVIRONMENT: 'production'
    })
    expect(production.delivery).toBe('provider')
    expect(production.linkOrigin).toBe('https://best.serp.co')
    expect(production.recipientAllowlist).toBeNull()
    expect(prefixedSubject(production, 'Hello')).toBe('Hello')
    expect(recipientAllowed(production, 'someone@example.com')).toBe(true)
  })

  it('sends to nobody on staging when the allowlist is empty or missing', () => {
    for (const value of [undefined, '', ' , ']) {
      const staging = resolveEmailPolicy({
        D1_RUNTIME_ENV: 'staging',
        EMAIL_STAGING_ALLOWLIST: value,
        SITE_ENVIRONMENT: 'staging'
      })
      expect(staging.recipientAllowlist?.size, String(value)).toBe(0)
      expect(recipientAllowed(staging, 'owner@serp.co')).toBe(false)
    }
  })

  it('fails closed on an unknown, missing, or mismatched environment', () => {
    const invalid = [
      {},
      { D1_RUNTIME_ENV: 'production' },
      { SITE_ENVIRONMENT: 'production' },
      { D1_RUNTIME_ENV: 'Production', SITE_ENVIRONMENT: 'Production' },
      { D1_RUNTIME_ENV: 'prod', SITE_ENVIRONMENT: 'prod' },
      { D1_RUNTIME_ENV: 'staging', SITE_ENVIRONMENT: 'production' },
      { D1_RUNTIME_ENV: 'production', SITE_ENVIRONMENT: 'local' }
    ]
    for (const vars of invalid) {
      expect(() => resolveEmailPolicy(vars), JSON.stringify(vars)).toThrow(EmailConfigError)
    }
  })

  it('rejects a malformed allowlist instead of guessing', () => {
    expect([...parseRecipientAllowlist(' A@Example.com,b@example.com,a@example.com ')]).toEqual([
      'a@example.com',
      'b@example.com'
    ])
    for (const value of [
      'owner@serp.co; other@serp.co',
      'Owner <owner@serp.co>',
      'not-an-address'
    ]) {
      expect(() => parseRecipientAllowlist(value), value).toThrow(EmailConfigError)
    }
    expect(() => parseRecipientAllowlist(['owner@serp.co'])).toThrow(EmailConfigError)
  })

  it('accepts exactly one plain address per recipient', () => {
    expect(normalizeEmailAddress('  Person.Name+tag@Example.CO.uk ')).toBe(
      'person.name+tag@example.co.uk'
    )
    for (const value of [
      'a@b.co, c@d.co',
      'a@b.co\r\nBcc: c@d.co',
      'Name <a@b.co>',
      'a b@c.co',
      'a@localhost',
      'a@-b.co',
      '@b.co',
      'a@',
      `${'a'.repeat(250)}@b.co`,
      42,
      null
    ]) {
      expect(normalizeEmailAddress(value), String(value)).toBeNull()
    }
  })

  it('links each environment to its own deployed origin', () => {
    expect(EMAIL_LINK_ORIGINS.staging).toBe(project.remote.staging.origin)
    expect(EMAIL_LINK_ORIGINS.production).toBe(project.remote.production.origin)
  })
})

describe('email senders and useSend settings', () => {
  it('sends from each environment’s verified useSend domain', () => {
    // serpcompany/best.serp.co#59 (provider changed to useSend): no Reply-To; the footer sends
    // people to the dashboard instead (#73).
    expect(emailSender('production')).toEqual({
      email: 'noreply@mail.serp.co',
      name: 'SERP Directory'
    })
    expect(emailSender('staging')).toEqual({
      email: 'noreply@mail-staging.serp.co',
      name: 'SERP Directory'
    })
    expect(emailSender('local')).toEqual(emailSender('staging'))
    expect(
      resolveEmailPolicy({ D1_RUNTIME_ENV: 'production', SITE_ENVIRONMENT: 'production' }).from
    ).toEqual(emailSender('production'))
    expect(
      resolveEmailPolicy({ D1_RUNTIME_ENV: 'staging', SITE_ENVIRONMENT: 'staging' }).from
    ).toEqual(emailSender('staging'))
    // A plain display name needs no quoting in `Name <address>`.
    expect(emailSender('production').name).toMatch(/^[A-Za-z0-9 ]+$/u)
    expect(EMAIL_DASHBOARD_PATH).toBe('/account/')
  })

  it('needs an https useSend origin and an API key, or email is disabled', () => {
    expect(
      resolveUseSendConfig({
        USESEND_API_KEY: ' us_key ',
        USESEND_BASE_URL: 'https://app.usesend.com/'
      })
    ).toEqual({ apiKey: 'us_key', baseUrl: 'https://app.usesend.com' })
    const invalid = [
      {},
      { USESEND_API_KEY: 'us_key' },
      { USESEND_BASE_URL: 'https://app.usesend.com' },
      { USESEND_API_KEY: '', USESEND_BASE_URL: 'https://app.usesend.com' },
      { USESEND_API_KEY: 'us key', USESEND_BASE_URL: 'https://app.usesend.com' },
      { USESEND_API_KEY: 'us_key', USESEND_BASE_URL: '' },
      { USESEND_API_KEY: 'us_key', USESEND_BASE_URL: 'http://app.usesend.com' },
      { USESEND_API_KEY: 'us_key', USESEND_BASE_URL: 'https://app.usesend.com/api' },
      { USESEND_API_KEY: 'us_key', USESEND_BASE_URL: 'https://app.usesend.com?x=1' },
      { USESEND_API_KEY: 'us_key', USESEND_BASE_URL: 'app.usesend.com' },
      // Only hosted useSend may receive the key.
      { USESEND_API_KEY: 'us_key', USESEND_BASE_URL: 'https://usesend.example.com' },
      { USESEND_API_KEY: 'us_key', USESEND_BASE_URL: 'https://app.usesend.com.evil.example' },
      { USESEND_API_KEY: 'us_key', USESEND_BASE_URL: 'https://APP.usesend.com:8443' }
    ]
    for (const env of invalid) {
      expect(() => resolveUseSendConfig(env), JSON.stringify(env)).toThrow(EmailConfigError)
    }
    try {
      resolveUseSendConfig({
        USESEND_API_KEY: 'us key',
        USESEND_BASE_URL: 'https://app.usesend.com'
      })
    } catch (error) {
      expect(String(error)).toContain(USESEND_API_KEY_SECRET)
      expect(String(error)).not.toContain('us key')
    }
  })
})

interface WranglerBlock {
  send_email?: unknown
  vars?: Record<string, string>
}

describe('apps/web/wrangler.jsonc email bindings', () => {
  const config = JSON.parse(
    readFileSync(new URL('../../wrangler.jsonc', import.meta.url), 'utf8')
  ) as WranglerBlock & { env: Record<'production' | 'staging', WranglerBlock> }

  it('points staging and production at hosted useSend, with no Cloudflare email binding', () => {
    expect(config.send_email).toBeUndefined()
    expect(config.vars?.[USESEND_BASE_URL_VAR]).toBeUndefined()
    for (const name of ['staging', 'production'] as const) {
      expect(config.env[name].send_email, name).toBeUndefined()
      expect(config.env[name].vars?.[USESEND_BASE_URL_VAR], name).toBe('https://app.usesend.com')
      // The API key is a Worker secret, never a var.
      expect(config.env[name].vars?.[USESEND_API_KEY_SECRET], name).toBeUndefined()
    }
    expect(config.vars?.[USESEND_API_KEY_SECRET]).toBeUndefined()
  })

  it('gives staging a valid, non-empty allowlist and production none', () => {
    const allowlist = parseRecipientAllowlist(config.env.staging.vars?.[STAGING_ALLOWLIST_VAR])
    expect(allowlist.size).toBeGreaterThan(0)
    expect(config.env.production.vars?.[STAGING_ALLOWLIST_VAR]).toBeUndefined()
    expect(config.vars?.[STAGING_ALLOWLIST_VAR]).toBeUndefined()
  })
})

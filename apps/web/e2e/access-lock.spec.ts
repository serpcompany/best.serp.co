import { generateKeyPairSync, sign } from 'node:crypto'
import { type APIRequestContext, expect, request as playwrightRequest } from '@playwright/test'
import {
  ACCESS_TEST_AUD,
  ACCESS_TEST_TEAM_DOMAIN,
  accessLockOrigin,
  accessLockServersEnabled
} from './access-lock-fixture'
import { test } from './test'

/**
 * The production Cloudflare Access lock in the built OpenNext Worker (serpcompany/best.serp.co#60;
 * docs/accounts.md#admin-gate). Two extra local Workers run with `CF_ACCESS_REQUIRED=on`, the
 * setting production always has: one without the team domain and AUD tag (production before the
 * owner sets them) and one with test values. Both lock `/admin` and `/api/admin` before any
 * session is considered, so even the signed-in owner is refused.
 */

const ADMIN_PATHS = [
  '/admin/',
  '/admin/not-a-page/',
  '/admin/submissions/x/',
  '/api/admin',
  '/api/admin/listings'
]

test.skip(
  !accessLockServersEnabled,
  'needs the local Access-lock Workers from playwright.config.ts'
)

/** Signs the seeded owner in on that Worker (its own empty D1) and returns a context with the session. */
async function ownerSession(origin: string): Promise<APIRequestContext> {
  const context = await playwrightRequest.newContext({ baseURL: origin })
  const headers = { 'cf-connecting-ip': '198.18.0.1', origin }
  const email = 'devin@serp.co'
  const requested = await context.post('/api/auth/email-otp/send-verification-otp', {
    data: { email, type: 'sign-in' },
    headers
  })
  expect(requested.status(), await requested.text()).toBe(200)
  const outbox = await context.get(`/api/auth/dev/otp-outbox?email=${encodeURIComponent(email)}`)
  const { otp } = (await outbox.json()) as { otp: string }
  const signedIn = await context.post('/api/auth/sign-in/email-otp', {
    data: { email, otp },
    headers
  })
  expect(signedIn.status(), await signedIn.text()).toBe(200)
  const session = await context.get('/api/auth/get-session')
  expect(((await session.json()) as { user: { email: string } }).user.email).toBe(email)
  return context
}

/**
 * An RS256 token with a `kid`, the exact claims the configured Worker expects (issuer, AUD),
 * signed by a throwaway key. It passes every check jose makes before resolving a key, so the
 * Worker fetches the test team's JWKS from inside workerd: the unknown team's certs URL answers
 * 404 (or the fetch fails offline), and either way no key verifies it, so the lock answers 403.
 */
function rs256TokenWithKid(): string {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const signingInput = `${encode({ alg: 'RS256', kid: 'e2e-throwaway', typ: 'JWT' })}.${encode({
    aud: [ACCESS_TEST_AUD],
    email: 'devin@serp.co',
    exp: now + 300,
    iat: now,
    iss: `https://${ACCESS_TEST_TEAM_DOMAIN}`
  })}`
  const signature = sign('RSA-SHA256', Buffer.from(signingInput), privateKey)
  return `${signingInput}.${signature.toString('base64url')}`
}

/** A well-formed HS256 token with Access-shaped claims; the lock accepts only RS256. */
function hs256Token(): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  return `${encode({ alg: 'HS256', kid: 'forged', typ: 'JWT' })}.${encode({
    aud: ['forged'],
    email: 'devin@serp.co',
    exp: now + 300,
    iat: now,
    iss: 'https://best-serp-co-e2e.cloudflareaccess.com'
  })}.${Buffer.from('signature').toString('base64url')}`
}

test.describe('Cloudflare Access lock without its configuration', () => {
  test('answers 503 "Access not configured" on every admin path, even to the owner', async () => {
    const origin = accessLockOrigin('unconfigured')
    const owner = await ownerSession(origin)
    try {
      for (const path of ADMIN_PATHS) {
        for (const method of ['GET', 'POST'] as const) {
          const response = await owner.fetch(path, {
            headers: { origin },
            maxRedirects: 0,
            method
          })
          expect(response.status(), `${method} ${path}`).toBe(503)
          expect(await response.text()).toBe('Access not configured\n')
          expect(response.headers()['cache-control']).toBe('private, no-store')
        }
      }
      // Everything else is served as usual.
      expect((await owner.get('/robots.txt')).status()).toBe(200)
      expect((await owner.get('/api/auth/get-session')).status()).toBe(200)
    } finally {
      await owner.dispose()
    }
  })
})

test.describe('Cloudflare Access lock with its configuration', () => {
  test('answers 403 without a valid Access JWT, even to the owner', async () => {
    const origin = accessLockOrigin('configured')
    const owner = await ownerSession(origin)
    try {
      for (const assertion of [
        undefined,
        '',
        'not.a.jwt',
        'a.b',
        hs256Token(),
        rs256TokenWithKid()
      ]) {
        for (const path of ADMIN_PATHS) {
          const response = await owner.get(path, {
            headers: assertion === undefined ? {} : { 'cf-access-jwt-assertion': assertion },
            maxRedirects: 0
          })
          expect(response.status(), `${path} with ${String(assertion).slice(0, 12)}`).toBe(403)
          expect(await response.text()).toBe('Forbidden\n')
        }
      }
      expect((await owner.get('/api/auth/get-session')).status()).toBe(200)
    } finally {
      await owner.dispose()
    }
  })

  test('answers 403 to anonymous visitors before the session check', async () => {
    const anonymous = await playwrightRequest.newContext({
      baseURL: accessLockOrigin('configured')
    })
    try {
      const response = await anonymous.get('/admin/', { maxRedirects: 0 })
      expect(response.status()).toBe(403)
    } finally {
      await anonymous.dispose()
    }
  })
})

/**
 * The checkout routes' return URLs (#467), through the real routes, `withCheckout` and
 * `publicOrigin`, with the billing service over stubbed operations and a recording provider. On
 * staging and production the provider's `success_url` and `cancel_url` start with the
 * environment's configured origin (`BETTER_AUTH_URL`) whatever host the client puts in the URL,
 * `Host` or `X-Forwarded-Host` (OpenNext turns the last into `Host`); without a valid origin the
 * route answers 503 and opens nothing. Only a local Worker without one uses the request's host.
 *
 * And no provider secret in a URL (#469): with the provider's secrets in the Worker's env, as
 * on staging and production, no URL a checkout route sends the buyer to or has the provider send
 * them back to carries one, and the buyer's returns redirect to bare pages.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GET as listingCheckout } from '@/app/(dashboard)/account/listings/[slug]/checkout/route'
import { GET as listingReturn } from '@/app/(dashboard)/account/listings/[slug]/checkout/success/route'
import { GET as claimCheckout } from '@/app/(site)/claims/[id]/checkout/route'
import { GET as claimReturn } from '@/app/(site)/claims/[id]/checkout/success/route'
import { GET as submissionCheckout } from '@/app/(site)/submit/[id]/checkout/start/route'
import type { CheckoutRequest } from './provider'
import { providerSecretsIn, TEST_PROVIDER_SECRETS } from './providers/test-support'
import type { BillingDependencies } from './service'

const { current, getCloudflareContext, USER } = vi.hoisted(() => {
  const USER = { email: 'owner@example.com', id: 'user-1' }
  return {
    current: { deps: null as unknown, user: USER as typeof USER | null },
    getCloudflareContext: vi.fn(),
    USER
  }
})

vi.mock('server-only', () => ({}))
vi.mock('@opennextjs/cloudflare', () => ({ getCloudflareContext }))
vi.mock('@/lib/billing/worker-billing', () => ({ createBillingDependencies: () => current.deps }))
vi.mock('@/lib/auth/server', () => ({ getRequestUser: async () => current.user }))
vi.mock('@/lib/account/pages', () => ({ requireAccountUser: async () => USER }))

const SPOOFED = 'evil.example'
const SUBMISSION = '11111111-1111-4111-8111-111111111111'
const CLAIM = '22222222-2222-4222-8222-222222222222'
const ORDER = 'order-1'
const SLUG = 'example.com'
const NOW = new Date('2026-10-15T12:00:00.000Z')

const STAGING = {
  BETTER_AUTH_URL: 'https://staging.best.serp.co',
  D1_RUNTIME_ENV: 'staging',
  SITE_ENVIRONMENT: 'staging'
}
const PRODUCTION = {
  BETTER_AUTH_URL: 'https://best.serp.co',
  D1_RUNTIME_ENV: 'production',
  SITE_ENVIRONMENT: 'production'
}
const LOCAL = { D1_RUNTIME_ENV: 'local', SITE_ENVIRONMENT: 'local' }

/** Each checkout route, how to call it, and the return paths its checkout should carry. */
const ROUTES = [
  {
    call: (request: Request) =>
      submissionCheckout(request, { params: Promise.resolve({ id: SUBMISSION }) }),
    cancelPath: `/submit/${SUBMISSION}/checkout/cancelled/`,
    name: 'submission',
    path: `/submit/${SUBMISSION}/checkout/start/`,
    successPath: `/submit/${SUBMISSION}/checkout/return/?order=${ORDER}`
  },
  {
    call: (request: Request) => claimCheckout(request, { params: Promise.resolve({ id: CLAIM }) }),
    cancelPath: `/products/${SLUG}/#claim`,
    name: 'claim',
    path: `/claims/${CLAIM}/checkout/`,
    successPath: `/claims/${CLAIM}/checkout/success/?order=${ORDER}`
  },
  {
    call: (request: Request) =>
      listingCheckout(request, { params: Promise.resolve({ slug: SLUG }) }),
    cancelPath: `/account/listings/${SLUG}/`,
    name: 'listing upgrade',
    path: `/account/listings/${SLUG}/checkout/`,
    successPath: `/account/listings/${SLUG}/checkout/success/?order=${ORDER}`
  }
] as const

/** Billing dependencies whose every target is payable, recording each checkout opened. */
function stubBilling(): CheckoutRequest[] {
  const checkouts: CheckoutRequest[] = []
  const deps = {
    currency: 'usd',
    newId: () => ORDER,
    now: () => NOW,
    operations: {
      apply: async () => true,
      checkoutListing: async () => ({
        id: 'listing-1',
        live: true,
        name: 'Example',
        ownerEmail: USER.email,
        ownerUserId: USER.id,
        retired: false,
        slug: SLUG,
        submission: {
          id: SUBMISSION,
          paidAt: null,
          plan: 'free',
          status: 'approved',
          unpublishedReason: null
        }
      }),
      checkoutSubmission: async () => ({
        id: SUBMISSION,
        listingId: null,
        name: 'Example',
        ownerUserId: USER.id,
        paidAt: null,
        plan: 'paid',
        refundedAt: null,
        status: 'pending_badge',
        website: `https://${SLUG}/`
      }),
      createOrder: async (input: Record<string, unknown>) => ({
        ...input,
        checkoutUrl: null,
        kind: 'listing'
      }),
      openOrder: async () => null,
      order: async () => null,
      websiteConflicts: async () => ({ blocked: false, listed: false })
    },
    paidClaims: {
      forCheckout: async () => ({
        confirmedUntil: new Date(NOW.getTime() + 2 * 60 * 60 * 1000),
        listingId: 'listing-1',
        listingName: 'Example'
      }),
      listing: async () => ({ listingSlug: SLUG })
    },
    priceCents: 4900,
    provider: {
      async createCheckout(request: CheckoutRequest) {
        checkouts.push(request)
        return {
          checkoutId: 'cs_1',
          expiresAt: request.expiresAt.toISOString(),
          url: 'https://pay.example/cs_1'
        }
      },
      name: 'test'
    }
  }
  current.deps = deps as unknown as BillingDependencies
  return checkouts
}

function worker(env: Record<string, string>): void {
  getCloudflareContext.mockResolvedValue({ ctx: { waitUntil: () => {} }, env })
}

/** A request whose URL, `Host` and `X-Forwarded-Host` all name a host the client chose. */
function spoofed(path: string): Request {
  return new Request(`https://${SPOOFED}${path}`, {
    headers: { host: SPOOFED, 'x-forwarded-host': SPOOFED }
  })
}

beforeEach(() => {
  current.user = USER
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  getCloudflareContext.mockReset()
})

describe.each([
  ['staging', STAGING],
  ['production', PRODUCTION]
])('checkout return URLs on %s', (_name, env) => {
  it.each(ROUTES)(
    'the $name checkout returns to the configured origin, not the client’s host',
    async route => {
      worker(env)
      const checkouts = stubBilling()

      const response = await route.call(spoofed(route.path))

      expect(response.status).toBe(303)
      expect(response.headers.get('location')).toBe('https://pay.example/cs_1')
      expect(checkouts).toHaveLength(1)
      expect(checkouts[0]?.successUrl).toBe(`${env.BETTER_AUTH_URL}${route.successPath}`)
      expect(checkouts[0]?.cancelUrl).toBe(`${env.BETTER_AUTH_URL}${route.cancelPath}`)
      expect(JSON.stringify(checkouts)).not.toContain(SPOOFED)
    }
  )

  it.each([
    ['missing', {}],
    ['empty', { BETTER_AUTH_URL: '' }],
    ['plain http', { BETTER_AUTH_URL: `http://${new URL(env.BETTER_AUTH_URL).host}` }],
    ['not an origin', { BETTER_AUTH_URL: `${env.BETTER_AUTH_URL}/submit/` }]
  ])(
    'answers 503 and opens no checkout when the configured origin is %s',
    async (_case, override) => {
      const { BETTER_AUTH_URL: _configured, ...rest } = env
      worker({ ...rest, ...override })
      const checkouts = stubBilling()

      for (const route of ROUTES) {
        const response = await route.call(spoofed(route.path))
        expect(response.status).toBe(503)
        expect(response.headers.get('location')).toBeNull()
      }
      expect(checkouts).toEqual([])
    }
  )

  // #477: the configured origin is looked up before the sign-in check, so a misconfigured
  // environment answers 503 to everyone instead of sending a signed-out visitor to sign in first.
  it.each(ROUTES.filter(route => route.name !== 'listing upgrade'))(
    'answers a signed-out visitor 503, not the sign-in page, on the $name checkout when the configured origin is missing',
    async route => {
      const { BETTER_AUTH_URL: _configured, ...rest } = env
      worker(rest)
      current.user = null
      const checkouts = stubBilling()

      const response = await route.call(spoofed(route.path))

      expect(response.status).toBe(503)
      expect(response.headers.get('location')).toBeNull()
      expect(checkouts).toEqual([])
    }
  )
})

describe('checkout return URLs on a local Worker', () => {
  it('uses the request’s own host without a configured origin', async () => {
    worker(LOCAL)
    const checkouts = stubBilling()
    const [route] = ROUTES
    const origin = 'http://127.0.0.1:9657'

    const response = await route.call(
      new Request(`${origin}${route.path}`, { headers: { host: '127.0.0.1:9657' } })
    )

    expect(response.status).toBe(303)
    expect(checkouts[0]?.successUrl).toBe(`${origin}${route.successPath}`)
    expect(checkouts[0]?.cancelUrl).toBe(`${origin}${route.cancelPath}`)
  })

  it('uses the configured origin when one is set', async () => {
    worker({ ...LOCAL, BETTER_AUTH_URL: 'http://localhost:8787' })
    const checkouts = stubBilling()
    const [route] = ROUTES

    await route.call(spoofed(route.path))

    expect(checkouts[0]?.successUrl).toBe(`http://localhost:8787${route.successPath}`)
  })

  it('is decided by the environment, not by one var or the host: a half-local Worker fails closed', async () => {
    worker({ D1_RUNTIME_ENV: 'staging', SITE_ENVIRONMENT: 'local' })
    const checkouts = stubBilling()
    const [route] = ROUTES

    const response = await route.call(
      new Request(`http://localhost:8787${route.path}`, { headers: { host: 'localhost:8787' } })
    )

    expect(response.status).toBe(503)
    expect(checkouts).toEqual([])
  })
})

describe('no provider secret in a checkout URL (#469)', () => {
  const SECRETS = Object.values(TEST_PROVIDER_SECRETS)

  it.each(ROUTES)(
    'the $name checkout sends the buyer out and back with no provider secret in either URL',
    async route => {
      worker({ ...PRODUCTION, ...TEST_PROVIDER_SECRETS })
      const checkouts = stubBilling()

      const response = await route.call(new Request(`${PRODUCTION.BETTER_AUTH_URL}${route.path}`))

      expect(response.status).toBe(303)
      const [checkout] = checkouts
      if (!checkout) throw new Error('no checkout opened')
      const urls = [response.headers.get('location') ?? '', checkout.successUrl, checkout.cancelUrl]
      for (const url of urls) expect(providerSecretsIn(url, SECRETS), url).toEqual([])
      // The provider sends the buyer back with our own order id and nothing else. A Checkout
      // Session id (`{CHECKOUT_SESSION_ID}`) is a public identifier, not a secret, but the order id
      // already finds the checkout, and adding one means first redirecting the return page to its
      // bare URL (serp's payments standard), so `providerSecretsIn` flags one on a site URL too.
      expect([...new URL(checkout.successUrl).searchParams]).toEqual([['order', ORDER]])
      expect(new URL(checkout.cancelUrl).search).toBe('')
    }
  )

  const RETURN_ORDER = '33333333-3333-4333-8333-333333333333'
  it.each([
    {
      call: (request: Request) => claimReturn(request, { params: Promise.resolve({ id: CLAIM }) }),
      location: `/products/${SLUG}/#claim`,
      name: 'claim',
      path: `/claims/${CLAIM}/checkout/success/?order=${RETURN_ORDER}`
    },
    {
      call: (request: Request) =>
        listingReturn(request, { params: Promise.resolve({ slug: SLUG }) }),
      location: `/account/listings/${SLUG}/`,
      name: 'listing upgrade',
      path: `/account/listings/${SLUG}/checkout/success/?order=${RETURN_ORDER}`
    }
  ])('the $name return redirects to its bare page', async route => {
    worker({ ...PRODUCTION, ...TEST_PROVIDER_SECRETS })
    stubBilling()

    const response = await route.call(new Request(`${PRODUCTION.BETTER_AUTH_URL}${route.path}`))

    expect(response.status).toBe(303)
    const location = response.headers.get('location') ?? ''
    expect(location).toBe(route.location)
    expect(providerSecretsIn(location, SECRETS)).toEqual([])
  })
})

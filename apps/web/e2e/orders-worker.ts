/**
 * The billing configuration of the admin panel suite's Worker (`admin-fixture.ts`), which the
 * orders suite (`billing.spec.ts`, #68) shares instead of starting a Worker of its own: every
 * preview Worker costs the CI runner about 1.5–2.5 GB of memory, and a ninth one exhausted it
 * (#111, run 37535200552). Orders are on everywhere (`features.orders`, #133); this gives a
 * Worker what staging and production have, the provider's secrets, as the suite's own test-mode
 * values (never real ones), with billing talking to the suite's mocked Stripe API on 127.0.0.1
 * (`LOCAL_STRIPE_MOCK_PORT`). The badge program suite's Worker takes it too, because the hourly
 * trigger it runs includes the billing sweep, which fails without the secrets. Other Workers
 * show the paid options, and their checkout answers 503, which no suite there opens.
 */

const playwrightPort = Number(process.env.PLAYWRIGHT_PORT ?? 3100)

/** Where the mocked Stripe API listens: +1 to +7 are the suites' Workers, +8 is free. */
export const stripeMockPort = playwrightPort + 8

export const E2E_STRIPE_SECRET_KEY = 'sk_test_e2emock'
export const E2E_STRIPE_WEBHOOK_SECRET = 'whsec_e2emock'

/** `LOCAL_PREVIEW_VARS` entries that configure billing with the mocked provider. */
export const BILLING_PREVIEW_VARS = [
  `LOCAL_STRIPE_MOCK_PORT=${stripeMockPort}`,
  `STRIPE_SECRET_KEY=${E2E_STRIPE_SECRET_KEY}`,
  `STRIPE_WEBHOOK_SECRET=${E2E_STRIPE_WEBHOOK_SECRET}`
]

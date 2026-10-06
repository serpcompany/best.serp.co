/**
 * The orders switches of the admin panel suite's Worker (`admin-fixture.ts`), which the orders
 * suite (`billing.spec.ts`, #68) shares instead of starting a Worker of its own: every preview
 * Worker costs the CI runner about 1.5–2.5 GB of memory, and a ninth one exhausted it (#111, run
 * 37535200552). Orders are on there (`LOCAL_ORDERS`, a local Worker only), billing talks to the
 * suite's mocked Stripe API on 127.0.0.1 (`LOCAL_STRIPE_MOCK_PORT`), and the keys are the suite's
 * own test-mode values, never real ones. No other suite on that Worker depends on orders being
 * off (the claims suites, which do, keep a Worker of their own).
 */

const playwrightPort = Number(process.env.PLAYWRIGHT_PORT ?? 3100)

/** Where the mocked Stripe API listens: +1 to +7 are the suites' Workers, +8 is free. */
export const stripeMockPort = playwrightPort + 8

export const E2E_STRIPE_SECRET_KEY = 'sk_test_e2emock'
export const E2E_STRIPE_WEBHOOK_SECRET = 'whsec_e2emock'

/** `LOCAL_PREVIEW_VARS` entries that turn orders on with the mocked provider. */
export const ORDERS_PREVIEW_VARS = [
  'LOCAL_ORDERS=on',
  `LOCAL_STRIPE_MOCK_PORT=${stripeMockPort}`,
  `STRIPE_SECRET_KEY=${E2E_STRIPE_SECRET_KEY}`,
  `STRIPE_WEBHOOK_SECRET=${E2E_STRIPE_WEBHOOK_SECRET}`
]

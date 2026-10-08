import { site } from '@serpdirectory/site-config'
import { isLocalWorker, type OrdersEnv } from '../flags'
import type { BillingProvider } from '../provider'
import { createStripeProvider } from './stripe'

/**
 * The configured billing provider (#68), from the Worker's secrets and vars. Everything that
 * names the provider (its secrets, account, key modes, the end-to-end mock) lives in this
 * folder, so the rest of billing, and everything people see, stays provider-neutral; swapping
 * in Lago means a `lago.ts` here and a change below.
 *
 * Today: Stripe, account `acct_1RiT0QCp8si97z5s`, test mode on staging and live mode in
 * production. Secrets (set by the owner, never by an agent): `STRIPE_SECRET_KEY` and
 * `STRIPE_WEBHOOK_SECRET`. Production takes only a live key, every other environment only a
 * test key, so staging can never charge a card. It fails closed: without both secrets, with a
 * key of the wrong mode, or with Stripe Tax on, it throws.
 */

export const STRIPE_ACCOUNT_ID = 'acct_1RiT0QCp8si97z5s'

export const STRIPE_SECRET_KEY_SECRET = 'STRIPE_SECRET_KEY'
export const STRIPE_WEBHOOK_SECRET_SECRET = 'STRIPE_WEBHOOK_SECRET'

export interface ProviderEnv extends OrdersEnv {
  /**
   * A local Worker only: the port of the end-to-end suite's mocked Stripe API on 127.0.0.1
   * (`apps/e2e/tests/billing-fixture.ts`), so the suite never reaches Stripe.
   */
  LOCAL_STRIPE_MOCK_PORT?: string
  STRIPE_SECRET_KEY?: string
  STRIPE_WEBHOOK_SECRET?: string
}

/** The key matches the environment: live keys in production only, test keys everywhere else. */
export function stripeKeyAllowed(key: string, environment: string | undefined): boolean {
  const live = /^(?:sk|rk)_live_[A-Za-z0-9]+$/u.test(key)
  const test = /^(?:sk|rk)_test_[A-Za-z0-9]+$/u.test(key)
  return environment === 'production' ? live : test
}

function stripeApiBase(env: ProviderEnv): string | undefined {
  if (!env.LOCAL_STRIPE_MOCK_PORT) return undefined
  if (!isLocalWorker(env)) throw new Error('LOCAL_STRIPE_MOCK_PORT is for a local Worker only.')
  if (!/^\d{2,5}$/u.test(env.LOCAL_STRIPE_MOCK_PORT)) {
    throw new Error('LOCAL_STRIPE_MOCK_PORT must be a port number.')
  }
  return `http://127.0.0.1:${env.LOCAL_STRIPE_MOCK_PORT}`
}

export function createConfiguredProvider(env: ProviderEnv): BillingProvider {
  const secretKey = env.STRIPE_SECRET_KEY?.trim() ?? ''
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET?.trim() ?? ''
  if (!secretKey || !webhookSecret) {
    throw new Error(`${STRIPE_SECRET_KEY_SECRET} and ${STRIPE_WEBHOOK_SECRET_SECRET} are required.`)
  }
  if (!stripeKeyAllowed(secretKey, env.D1_RUNTIME_ENV)) {
    throw new Error(`${STRIPE_SECRET_KEY_SECRET} is not a key for this environment.`)
  }
  if (site.submissions.automaticTax) {
    // Tax changes what Stripe charges, and the ledger refuses a charge that doesn't match the
    // order (and refunds it), so Stripe Tax stays off until billing handles it.
    throw new Error('Stripe Tax is not supported by billing yet.')
  }
  return createStripeProvider({
    accountId: STRIPE_ACCOUNT_ID,
    apiBase: stripeApiBase(env),
    live: env.D1_RUNTIME_ENV === 'production',
    secretKey,
    webhookSecret
  })
}

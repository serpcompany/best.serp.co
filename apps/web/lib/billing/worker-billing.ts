import { createBadgeProgramOperations } from '@serpdirectory/data-ops/badge-program'
import { createBillingOperations } from '@serpdirectory/data-ops/billing'
import { createDatabase } from '@serpdirectory/data-ops/client'
import { site } from '@serpdirectory/site-config'
import { checkBadgeAtRefund } from '../badge-program/refund'
import { EMAIL_ADMIN_RECIPIENT } from '../email/config'
import { emailEventKey } from '../email/service'
import { verifyFeaturedBadge } from '../submissions/badge-verifier'
import { submissionBadgeVerificationTargets } from '../submissions/presentation'
import { isLocalWorker, type OrdersEnv } from './flags'
import { runGuardrails } from './guardrails'
import type { BillingDependencies, Notify } from './service'
import { createStripeProvider } from './stripe'

/**
 * Builds the billing service's dependencies from the Worker's bindings (#68), for requests
 * (`runtime.ts`) and the scheduled sweep alike. It fails closed: without the `DB` binding, a
 * valid `D1_RUNTIME_ENV`, or the Stripe secrets it throws, so nothing is half-configured.
 *
 * Secrets (set by the owner, never by an agent): `STRIPE_SECRET_KEY` and
 * `STRIPE_WEBHOOK_SECRET`. Production takes only a live key, every other environment only a
 * test key, so staging can never charge a card.
 */

/** SERP's Stripe account (#68): test mode on staging, live mode in production. */
export const STRIPE_ACCOUNT_ID = 'acct_1RiT0QCp8si97z5s'

export const STRIPE_SECRET_KEY_SECRET = 'STRIPE_SECRET_KEY'
export const STRIPE_WEBHOOK_SECRET_SECRET = 'STRIPE_WEBHOOK_SECRET'

export interface BillingEnv extends OrdersEnv {
  DB?: D1Database
  /**
   * A local Worker only: the port of the end-to-end suite's mocked Stripe API on 127.0.0.1
   * (`apps/e2e/tests/billing-fixture.ts`), so the suite never reaches Stripe.
   */
  LOCAL_STRIPE_MOCK_PORT?: string
  STRIPE_SECRET_KEY?: string
  STRIPE_WEBHOOK_SECRET?: string
}

const runtimeEnvironments = new Set(['local', 'staging', 'production'])

/** The key matches the environment: live keys in production only, test keys everywhere else. */
export function stripeKeyAllowed(key: string, environment: string | undefined): boolean {
  const live = /^(?:sk|rk)_live_[A-Za-z0-9]+$/u.test(key)
  const test = /^(?:sk|rk)_test_[A-Za-z0-9]+$/u.test(key)
  return environment === 'production' ? live : test
}

function stripeApiBase(env: BillingEnv): string | undefined {
  if (!env.LOCAL_STRIPE_MOCK_PORT) return undefined
  if (!isLocalWorker(env)) throw new Error('LOCAL_STRIPE_MOCK_PORT is for a local Worker only.')
  if (!/^\d{2,5}$/u.test(env.LOCAL_STRIPE_MOCK_PORT)) {
    throw new Error('LOCAL_STRIPE_MOCK_PORT must be a port number.')
  }
  return `http://127.0.0.1:${env.LOCAL_STRIPE_MOCK_PORT}`
}

export function createBillingDependencies(input: {
  env: BillingEnv
  notify: Notify
}): BillingDependencies {
  const { env } = input
  if (!env.DB) throw new Error('D1 binding DB is required for billing.')
  if (!runtimeEnvironments.has(env.D1_RUNTIME_ENV ?? '')) {
    throw new Error('A valid D1_RUNTIME_ENV is required for billing.')
  }
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
  const client = createDatabase(env.DB)
  const operations = createBillingOperations({ client })
  const badgeProgram = createBadgeProgramOperations({ client })
  return {
    adminRecipient: EMAIL_ADMIN_RECIPIENT,
    badgeAtRefund: listingId =>
      checkBadgeAtRefund({
        listingId,
        now: new Date(),
        operations: badgeProgram,
        verify: listing =>
          verifyFeaturedBadge(listing.website, submissionBadgeVerificationTargets(listing.slug))
      }),
    currency: 'usd',
    eventKey: emailEventKey,
    guardrails: website =>
      runGuardrails({ conflicts: value => operations.websiteConflicts(value), website }),
    newId: () => crypto.randomUUID(),
    notify: input.notify,
    now: () => new Date(),
    operations,
    // #67's claims module wires `completePaidClaim` here once it is merged.
    paidClaims: undefined,
    priceCents: site.submissions.paidListingPriceCents,
    provider: createStripeProvider({
      accountId: STRIPE_ACCOUNT_ID,
      apiBase: stripeApiBase(env),
      live: env.D1_RUNTIME_ENV === 'production',
      secretKey,
      webhookSecret
    })
  }
}

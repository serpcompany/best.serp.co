import { createBadgeProgramOperations } from '@/db/badge-program'
import { createBillingOperations } from '@/db/billing'
import { createDatabase } from '@/db/client'
import { site } from '@/lib/site'
import { checkBadgeAtRefund } from '../badge-program/refund'
import { EMAIL_ADMIN_RECIPIENT } from '../email/config'
import { emailEventKey } from '../email/service'
import { features as siteFeatures } from '../features'
import { verifyFeaturedBadge } from '../submissions/badge-verifier'
import { submissionBadgeVerificationTargets } from '../submissions/presentation'
import { runGuardrails } from './guardrails'
import { createPaidClaims } from './paid-claims'
import { createConfiguredProvider, type ProviderEnv } from './providers'
import type { BillingDependencies, Notify } from './service'

/**
 * Builds the billing service's dependencies from the Worker's bindings (#68), for requests
 * (`runtime.ts`) and the scheduled sweep alike. It fails closed: without the `DB` binding, a
 * valid `D1_RUNTIME_ENV`, or the provider's configuration (`providers/index.ts`) it throws,
 * so nothing is half-configured.
 */

export interface BillingEnv extends ProviderEnv {
  DB?: D1Database
  /** `on` turns claims on for a local Worker (`lib/claims/flags.ts`); paid claims need both. */
  LOCAL_CLAIMS?: string
}

const runtimeEnvironments = new Set(['local', 'staging', 'production'])

export function createBillingDependencies(input: {
  env: BillingEnv
  notify: Notify
}): BillingDependencies {
  const { env } = input
  if (!env.DB) throw new Error('D1 binding DB is required for billing.')
  if (!runtimeEnvironments.has(env.D1_RUNTIME_ENV ?? '')) {
    throw new Error('A valid D1_RUNTIME_ENV is required for billing.')
  }
  const provider = createConfiguredProvider(env)
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
    // Paid claims need claims on as well as orders (#67's `completePaidClaim`).
    paidClaims: createPaidClaims({ client, env, features: siteFeatures }),
    priceCents: site.submissions.paidListingPriceCents,
    provider
  }
}

import 'server-only'

import { getCloudflareContext } from '@opennextjs/cloudflare'
import { createClaimOperations } from '@serpdirectory/data-ops/claims'
import { createDatabase } from '@serpdirectory/data-ops/client'
import { claimCodeKey, consumeRequestRateLimit } from '@/lib/auth/server'
import { emailEventKey, enqueueEmail } from '@/lib/email/server'
import { features as siteFeatures } from '@/lib/features'
import { type ClaimFlags, claimFlags } from './flags'
import { claimRecipientRateLimitRules } from './limits'
import { safeResolveLanding } from './product'
import type { ClaimDependencies } from './service'

/**
 * Server-only adapter for claims (#67): validates the Worker's `DB` binding and
 * `D1_RUNTIME_ENV`, and wires the claim flow to D1 (`@serpdirectory/data-ops/claims`), the
 * code key, and the email module. All SQL lives in data-ops.
 */

const runtimeEnvironments = new Set(['local', 'staging', 'production'])

interface ClaimEnv {
  D1_RUNTIME_ENV?: string
  DB?: D1Database
  LOCAL_CLAIMS?: string
  SITE_ENVIRONMENT?: string
}

async function claimEnv(): Promise<ClaimEnv> {
  const { env } = await getCloudflareContext({ async: true })
  return env as unknown as ClaimEnv
}

/** Whether claims are on for this Worker (`features.claims`, or a local Worker that asks). */
export async function currentClaimFlags(): Promise<ClaimFlags> {
  return claimFlags(await claimEnv(), siteFeatures)
}

export async function claimDependencies(): Promise<ClaimDependencies> {
  const env = await claimEnv()
  if (!env.DB) throw new Error('D1 binding DB is required for claims.')
  if (!runtimeEnvironments.has(env.D1_RUNTIME_ENV ?? '')) {
    throw new Error('A valid D1_RUNTIME_ENV is required for claims.')
  }
  const flags = claimFlags(env, siteFeatures)
  return {
    codeKey: await claimCodeKey(),
    contactPath: flags.contactPath,
    now: () => new Date(),
    operations: createClaimOperations({ client: createDatabase(env.DB) }),
    paidClaims: flags.paid,
    resolveLanding: safeResolveLanding(),
    async sendBudget(input) {
      const decision = await consumeRequestRateLimit(claimRecipientRateLimitRules(input))
      return decision.allowed ? null : { retryAfterSeconds: decision.retryAfterSeconds }
    },
    async sendCode({ claimId, code, codesSent, listingName, to }) {
      // Each code is its own email: the claim and the count of codes sent key the ledger.
      await enqueueEmail('claim-code', {
        eventKey: emailEventKey('claim-code', claimId, String(codesSent)),
        input: { code, listingName },
        to
      })
    }
  }
}

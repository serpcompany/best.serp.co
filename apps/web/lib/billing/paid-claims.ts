import { CLAIM_VERIFIED_TTL_HOURS, createClaimOperations } from '@serpdirectory/data-ops/claims'
import type { Database } from '@serpdirectory/data-ops/client'
import { claimFlags } from '../claims/flags'
import { safeResolveLanding } from '../claims/product'
import { completePaidClaim } from '../claims/service'
import type { SiteFeatures } from '../features'
import type { OrdersEnv } from './flags'
import type { PaidClaimListing, PaidClaims } from './service'

/**
 * Paid claims (#67 × #68): billing's claim hook, on #67's claim flow. Present only while claims
 * are on as well as orders (`claimFlags`); otherwise a paid claim can't start a checkout and a
 * claim payment that arrives anyway is refunded. A payment completes the claim through
 * `completePaidClaim`, which re-checks the claim, the product domain and that nobody owns the
 * listing; when it can't, the payment is refunded.
 */
export function createPaidClaims(input: {
  client: Database
  env: OrdersEnv & { LOCAL_CLAIMS?: string }
  features: SiteFeatures
  now?: () => Date
}): PaidClaims | undefined {
  const flags = claimFlags(input.env, input.features)
  if (!flags.enabled || !flags.paid) return undefined
  const operations = createClaimOperations({ client: input.client })
  const now = input.now ?? (() => new Date())
  const deps = {
    contactPath: flags.contactPath,
    now,
    operations,
    paidClaims: true,
    resolveLanding: safeResolveLanding()
  }
  const listing = async (claim: {
    claimId: string
    userId: string
  }): Promise<PaidClaimListing | null> => {
    const found = await operations.claim(claim)
    if (!found) return null
    const target = await operations.listing({ id: found.listingId })
    return target
      ? { listingId: target.id, listingName: target.name, listingSlug: target.slug }
      : null
  }
  return {
    async complete(claim) {
      const result = await completePaidClaim(deps, claim)
      return result.ok && result.completed
    },
    async forCheckout(claim) {
      const found = await operations.claim(claim)
      if (found?.method !== 'paid' || found.status !== 'email_verified') return null
      const verifiedAt = found.emailVerifiedAt ? Date.parse(found.emailVerifiedAt) : 0
      if (verifiedAt < now().getTime() - CLAIM_VERIFIED_TTL_HOURS * 60 * 60 * 1000) return null
      const target = await operations.listing({ id: found.listingId })
      if (!target || target.ownerUserId) return null
      return { listingId: target.id, listingName: target.name, listingSlug: target.slug }
    },
    listing
  }
}

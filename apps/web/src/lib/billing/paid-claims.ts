import { CLAIM_VERIFIED_TTL_HOURS, createClaimOperations } from '@/db/claims'
import type { Database } from '@/db/client'
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
      // True only when this call completed the claim, in one batch with `together`.
      const result = await completePaidClaim(deps, claim)
      return result.ok && result.completedNow
    },
    async forCheckout(claim) {
      const found = await operations.claim(claim)
      if (found?.method !== 'paid' || found.status !== 'email_verified') return null
      const verifiedAt = found.emailVerifiedAt ? Date.parse(found.emailVerifiedAt) : 0
      const confirmedUntil = new Date(verifiedAt + CLAIM_VERIFIED_TTL_HOURS * 60 * 60 * 1000)
      if (confirmedUntil.getTime() <= now().getTime()) return null
      const target = await operations.listing({ id: found.listingId })
      if (!target || target.ownerUserId) return null
      return {
        confirmedUntil,
        listingId: target.id,
        listingName: target.name,
        listingSlug: target.slug
      }
    },
    listing
  }
}

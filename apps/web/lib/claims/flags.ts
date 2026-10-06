import { ordersEnabledFor } from '../billing/flags'
import type { SiteFeatures } from '../features'

/**
 * Claims (#67) run only while `features.claims` is on, or on a local Worker started with
 * `LOCAL_CLAIMS=on` (`LOCAL_PREVIEW_VARS`, for the end-to-end suite; ignored unless
 * `SITE_ENVIRONMENT` and `D1_RUNTIME_ENV` are both `local`). While off, every claim endpoint
 * answers 404. Paid claims also need `features.orders` (#68): with it off, only the badge
 * method exists (a local Worker started with `LOCAL_ORDERS=on` counts, as billing does).
 */
export interface ClaimFlags {
  /** Where an "already owned" answer sends someone: a claim conversation (#73) or /contact/. */
  contactPath: string
  enabled: boolean
  paid: boolean
}

export function claimFlags(
  env: {
    D1_RUNTIME_ENV?: string
    LOCAL_CLAIMS?: string
    LOCAL_ORDERS?: string
    SITE_ENVIRONMENT?: string
  },
  features: SiteFeatures
): ClaimFlags {
  const local =
    env.LOCAL_CLAIMS === 'on' && env.SITE_ENVIRONMENT === 'local' && env.D1_RUNTIME_ENV === 'local'
  return {
    contactPath: features.messages ? '/account/messages/new/?type=claim' : '/contact/',
    enabled: features.claims || local,
    paid: ordersEnabledFor(env, features)
  }
}

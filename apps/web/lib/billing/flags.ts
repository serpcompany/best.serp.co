import { type SiteFeatures, features as siteFeatures } from '../features'

/**
 * Whether orders (#68) are on for this Worker: `features.orders`, which the owner turns on, or
 * a local Worker started with `LOCAL_ORDERS=on` (`LOCAL_PREVIEW_VARS`) for the end-to-end
 * suite, which runs against a mocked payment provider. `LOCAL_ORDERS` is ignored unless both
 * `SITE_ENVIRONMENT` and `D1_RUNTIME_ENV` are `local`, so a deployed Worker never reads it.
 * Off: every checkout route and the webhook answer 404, the admin Orders screen is a 404, the
 * submit and account pages show no paid option, and the sweep does nothing.
 */
export interface OrdersEnv {
  D1_RUNTIME_ENV?: string
  LOCAL_ORDERS?: string
  SITE_ENVIRONMENT?: string
}

export function isLocalWorker(env: OrdersEnv): boolean {
  return env.SITE_ENVIRONMENT === 'local' && env.D1_RUNTIME_ENV === 'local'
}

export function ordersEnabledFor(env: OrdersEnv, features: SiteFeatures = siteFeatures): boolean {
  if (features.orders) return true
  return env.LOCAL_ORDERS === 'on' && isLocalWorker(env)
}

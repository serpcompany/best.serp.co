import { STRIPE_SECRET_KEY_SECRET, STRIPE_WEBHOOK_SECRET_SECRET } from './index'

/**
 * Tests only: the configured provider's test-mode secrets as Worker env entries, for tests that
 * run billing through the Worker's own configuration (`createConfiguredProvider`), such as the
 * hourly trigger's billing sweep in `lib/worker/scheduled.test.ts`. The secrets' names stay in
 * this folder (architecture guard).
 */
export const TEST_PROVIDER_SECRETS: Readonly<Record<string, string>> = {
  [STRIPE_SECRET_KEY_SECRET]: 'sk_test_unit',
  [STRIPE_WEBHOOK_SECRET_SECRET]: 'whsec_unit'
}

/** The configured provider's error when its secrets are missing. */
export const MISSING_PROVIDER_SECRETS = `${STRIPE_SECRET_KEY_SECRET} and ${STRIPE_WEBHOOK_SECRET_SECRET} are required.`

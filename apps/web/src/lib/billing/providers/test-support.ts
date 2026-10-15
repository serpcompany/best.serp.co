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

/**
 * The shapes of the provider's secrets. A Checkout Session id (`cs_test_…`, `cs_live_…`) is not
 * one: it is a public identifier that does nothing without the secret key, and Stripe documents
 * it for return URLs (`{CHECKOUT_SESSION_ID}`). The code puts one in API paths, the admin's
 * dashboard link, and the provider's own checkout page URL, so it stays allowed. A publishable
 * key (`pk_…`) is public too.
 */
const SECRET_SHAPES: ReadonlyArray<readonly [string, RegExp]> = [
  ['secret or restricted key', /(?<![A-Za-z0-9])[rs]k_(?:live|test)_[A-Za-z0-9]/u],
  ['webhook signing secret', /(?<![A-Za-z0-9])whsec_[A-Za-z0-9]/u],
  ['ephemeral key', /(?<![A-Za-z0-9])ek_(?:live|test)_[A-Za-z0-9]/u],
  ['client secret', /_secret_[A-Za-z0-9]/u],
  ['webhook signature', /(?<![A-Za-z0-9])(?:t=\d+,v1=|v1=[0-9a-f]{64})/u],
  [
    'secret-bearing parameter',
    /[?&#;](?:[A-Za-z0-9]+[-_])*(?:api[-_]?key|key|secret|signature|sig|token)=/iu
  ]
]

/** The URL as written and percent-decoded up to three times, so an encoded secret still shows. */
function urlForms(url: string): string[] {
  const forms = [url]
  for (let round = 0; round < 3; round += 1) {
    const last = forms[forms.length - 1] ?? ''
    let decoded: string
    try {
      decoded = decodeURIComponent(last)
    } catch {
      break
    }
    if (decoded === last) break
    forms.push(decoded)
  }
  return forms
}

/**
 * Tests only (#469): which provider secrets a URL carries, for the tests that pin that no URL
 * the site builds or sends a buyer to ever carries one (serp's payments standard, "Keep tokens
 * out of analytics and logs"). A URL reaches browser history, analytics, `Referer` headers and
 * logs, so none may hold the provider's secret or restricted key, its webhook signing secret, an
 * ephemeral key, a client secret, a webhook signature, or a parameter named for one; nor any of
 * `known`, the secrets a test configured, as written or percent-encoded, anywhere in it. An
 * empty list means none.
 */
export function providerSecretsIn(url: string, known: readonly string[] = []): string[] {
  const forms = urlForms(url)
  const found = SECRET_SHAPES.filter(([, shape]) => forms.some(form => shape.test(form))).map(
    ([name]) => name
  )
  for (const [index, secret] of known.entries()) {
    if (secret && forms.some(form => form.includes(secret))) {
      found.push(`configured secret ${index}`)
    }
  }
  return found
}

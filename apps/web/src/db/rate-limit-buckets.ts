/**
 * The bucket names of `auth_rate_limit_hits` (serpcompany/best.serp.co#60): HMAC-SHA256 of
 * `<scope>\0<key>` under the rate-limit key, as hex, so a database reader cannot recover an email
 * or IP address by enumerating them. `createAuthOperations` (`./auth.ts`) counts hits in these
 * buckets; the claims E2E suite names one to empty it (`apps/web/e2e/claims-fixture.ts`, #200).
 * No Worker or Node APIs, so both can import it.
 */

const encoder = new TextEncoder()

/** The HMAC key for bucket names, from the rate-limit key (32+ characters). */
export async function rateLimitBucketKey(rateLimitKey: string): Promise<CryptoKey> {
  if (rateLimitKey.length < 32) {
    throw new Error('Auth rate limits need an HMAC key of 32+ characters.')
  }
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(rateLimitKey),
    { hash: 'SHA-256', name: 'HMAC' },
    false,
    ['sign']
  )
}

/** The bucket a rule's key counts in, as 64 hex characters. */
export async function rateLimitBucket(
  bucketKey: CryptoKey,
  rule: { key: string; scope: string }
): Promise<string> {
  const digest = await crypto.subtle.sign(
    'HMAC',
    bucketKey,
    encoder.encode(`${rule.scope}\0${rule.key}`)
  )
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

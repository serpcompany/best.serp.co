/**
 * Purpose-bound keys derived from `BETTER_AUTH_SECRET` (serpcompany/best.serp.co#60). Better
 * Auth signs session cookies with HMAC-SHA256 under the secret itself; every other use gets its
 * own key, `HMAC-SHA256(secret, label)`, so no two uses ever share key material and rotating
 * the secret rotates them all.
 */

export const RATE_LIMIT_KEY_LABEL = 'best.serp.co/auth-rate-limit/v1'
export const KNOWN_DEVICE_KEY_LABEL = 'best.serp.co/known-device/v1'

const encoder = new TextEncoder()

/** The derived key for `label`, as 64 hex characters. */
export async function deriveKey(secret: string, label: string): Promise<string> {
  if (!secret) throw new Error('A key can only be derived from a non-empty secret.')
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { hash: 'SHA-256', name: 'HMAC' },
    false,
    ['sign']
  )
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(label))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

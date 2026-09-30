interface PreviewCapabilityPayload {
  exp: number
  run: string
  slug: string
}

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='))
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}

async function signature(payload: string, secret: string): Promise<Uint8Array> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { hash: 'SHA-256', name: 'HMAC' },
    false,
    ['sign']
  )
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(payload)))
}

export async function createReplatformPreviewCapability(input: {
  expiresAt: number
  runId: string
  secret: string
  slug: string
}): Promise<string> {
  if (input.secret.length < 32 || !input.runId || !/^[a-z0-9.-]+$/u.test(input.slug))
    throw new Error('Invalid Preview capability input.')
  const payload = base64Url(
    new TextEncoder().encode(
      JSON.stringify({ exp: input.expiresAt, run: input.runId, slug: input.slug })
    )
  )
  return `${payload}.${base64Url(await signature(payload, input.secret))}`
}

export async function verifyReplatformPreviewCapability(input: {
  now: number
  runId: string
  secret: string
  slug: string
  token: string
}): Promise<boolean> {
  if (input.secret.length < 32) return false
  const [payload, suppliedSignature, extra] = input.token.split('.')
  if (!payload || !suppliedSignature || extra) return false
  let parsed: PreviewCapabilityPayload
  let supplied: Uint8Array
  try {
    parsed = JSON.parse(
      new TextDecoder().decode(fromBase64Url(payload))
    ) as PreviewCapabilityPayload
    supplied = fromBase64Url(suppliedSignature)
  } catch {
    return false
  }
  const expected = await signature(payload, input.secret)
  let difference = supplied.length ^ expected.length
  for (let index = 0; index < Math.max(supplied.length, expected.length); index += 1)
    difference |= (supplied[index] ?? 0) ^ (expected[index] ?? 0)
  return (
    difference === 0 &&
    parsed.exp >= input.now &&
    parsed.exp <= input.now + 15 * 60 &&
    parsed.run === input.runId &&
    parsed.slug === input.slug
  )
}

export function resolveRehearsalRateFingerprint(
  before: readonly string[],
  afterFirstControlledRequest: readonly string[]
): string {
  if (before.length !== 0 || afterFirstControlledRequest.length !== 1)
    throw new Error('Rehearsal rate fingerprint requires isolated empty state and exactly one row.')
  const [fingerprint] = afterFirstControlledRequest
  if (!fingerprint) throw new Error('Rehearsal rate fingerprint is missing.')
  return fingerprint
}

/**
 * Staging's password (#359; serp `docs/engineering/standards/staging-access.md`,
 * serpcompany/serp#1458). Staging sits behind HTTP Basic auth, so it can describe itself exactly
 * as production will (indexable, canonical on its own host) while search engines and the public
 * stay out. SEO auditors get the password and crawl staging as search engines will crawl
 * best.serp.co.
 *
 * - **Where:** the Worker entry (`lib/worker/handle-request.ts`), right after the
 *   canonical-host redirect and before everything else, including the edge HTML cache, on every
 *   host the staging Worker answers. Production and local never have it (`servesAsStaging`); the
 *   e2e suite runs one local Worker with `LOCAL_STAGING_ACCESS=on` to test it.
 * - **The password** is `STAGING_BASIC_AUTH_PASSWORD`, a plain var in `env.staging.vars` of
 *   `apps/web/wrangler.jsonc`. It is not a secret (the owner's decision on #359): SERP sites
 *   share it, serp's standard states it, and it only keeps crawlers and the public out of a site
 *   whose content is the public site's. Only the password is checked: the username is ignored
 *   (people and Ahrefs use `staging`, `STAGING_ACCESS_USERNAME`).
 * - **Fail closed:** without the var (missing or empty), every request is refused except the
 *   exemptions.
 * - **Comparison:** SHA-256 of both values, compared in constant time
 *   (`crypto.subtle.timingSafeEqual` in workerd).
 * - **The 401** carries `WWW-Authenticate: Basic` and `Cache-Control: no-store`. It is answered
 *   before the edge cache, so it is never stored.
 * - **A request that passes** goes on without its `Authorization` header, so it is cached like
 *   an anonymous one, and gets no environment noindex (`withEnvironmentHeaders`).
 * - **Exemptions** (served without the password, and kept `noindex`): requests with the
 *   smoke-test header (CI), `GET`/`HEAD /robots.txt`, and the billing provider's test-mode webhook
 *   (`POST /api/billing/webhook/`), which proves itself with its own signature.
 *
 * This module has no Next.js or `server-only` imports so the Worker can run it before OpenNext.
 */
import { type SiteEnvironmentEnv, SMOKE_TEST_HEADER, servesAsStaging } from './site-environment'

/** The username people and auditors give (Ahrefs needs one); the gate ignores it. */
export const STAGING_ACCESS_USERNAME = 'staging'
export const STAGING_ACCESS_REALM = 'best.serp.co staging'
export const STAGING_ACCESS_CHALLENGE = `Basic realm="${STAGING_ACCESS_REALM}", charset="UTF-8"`

/** The billing provider's webhook (`app/api/billing/webhook/route.ts`, docs/billing.md). */
const WEBHOOK_PATHS: ReadonlySet<string> = new Set([
  '/api/billing/webhook',
  '/api/billing/webhook/'
])

export interface StagingAccessEnv extends SiteEnvironmentEnv {
  /** The password; set in `env.staging.vars` (`apps/web/wrangler.jsonc`). */
  STAGING_BASIC_AUTH_PASSWORD?: string
}

/**
 * - `none`: not a Worker that serves as staging (production, local); nothing is checked.
 * - `exempt`: an exemption; served without the password, and noindex.
 * - `passed`: the password matched; `request` is the request without `Authorization`.
 * - `refused`: the 401 to answer.
 */
export type StagingAccess =
  | { gate: 'none' }
  | { gate: 'exempt' }
  | { gate: 'passed'; request: Request }
  | { gate: 'refused'; response: Response }

/** The requests served without the password (see the module comment). */
export function isStagingAccessExempt(request: Request): boolean {
  if (request.headers.has(SMOKE_TEST_HEADER)) return true
  const { pathname } = new URL(request.url)
  if (pathname === '/robots.txt') return request.method === 'GET' || request.method === 'HEAD'
  return request.method === 'POST' && WEBHOOK_PATHS.has(pathname)
}

/**
 * The password of an `Authorization: Basic` header, or null when there is none or it is
 * malformed. The username (before the first colon) is ignored.
 */
export function basicAuthPassword(header: string | null): string | null {
  const encoded = /^basic[ \t]+([A-Za-z0-9+/]+={0,2})[ \t]*$/iu.exec(header ?? '')?.[1]
  if (!encoded) return null
  let binary: string
  try {
    binary = atob(encoded)
  } catch {
    return null
  }
  const decoded = new TextDecoder().decode(Uint8Array.from(binary, char => char.charCodeAt(0)))
  const separator = decoded.indexOf(':')
  return separator === -1 ? null : decoded.slice(separator + 1)
}

function sha256(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
}

type TimingSafeSubtle = SubtleCrypto & {
  timingSafeEqual?: (left: ArrayBuffer, right: ArrayBuffer) => boolean
}

/**
 * Compares two SHA-256 digests in constant time: workerd's `crypto.subtle.timingSafeEqual`, or,
 * where it is missing (Node, which runs the unit tests), every byte with no early exit.
 */
function digestsEqual(left: ArrayBuffer, right: ArrayBuffer): boolean {
  const subtle = crypto.subtle as TimingSafeSubtle
  if (typeof subtle.timingSafeEqual === 'function') return subtle.timingSafeEqual(left, right)
  const a = new Uint8Array(left)
  const b = new Uint8Array(right)
  let difference = a.length ^ b.length
  for (let index = 0; index < a.length; index += 1) difference |= (a[index] ?? 0) ^ (b[index] ?? 0)
  return difference === 0
}

/** True when the request's Basic password is exactly `expected`; false when either is missing. */
export async function stagingPasswordMatches(
  request: Request,
  expected: string | undefined
): Promise<boolean> {
  if (!expected) return false
  const given = basicAuthPassword(request.headers.get('authorization'))
  if (given === null) return false
  const [givenDigest, expectedDigest] = await Promise.all([sha256(given), sha256(expected)])
  return digestsEqual(givenDigest, expectedDigest)
}

/** The 401 that asks for the password. Never cached by anyone. */
export function stagingAccessChallenge(request: Request): Response {
  return new Response(request.method === 'HEAD' ? null : 'Staging requires a password.\n', {
    headers: {
      'cache-control': 'no-store',
      'content-type': 'text/plain; charset=utf-8',
      'www-authenticate': STAGING_ACCESS_CHALLENGE
    },
    status: 401
  })
}

/** The request as it goes on once it passed: the same, without its `Authorization` header. */
function withoutAuthorization(request: Request): Request {
  const headers = new Headers(request.headers)
  headers.delete('authorization')
  return new Request(request, { headers })
}

/** Staging's gate for one request (see `StagingAccess`). */
export async function stagingAccess(
  request: Request,
  env: StagingAccessEnv
): Promise<StagingAccess> {
  if (!servesAsStaging(env)) return { gate: 'none' }
  if (isStagingAccessExempt(request)) return { gate: 'exempt' }
  if (await stagingPasswordMatches(request, env.STAGING_BASIC_AUTH_PASSWORD))
    return { gate: 'passed', request: withoutAuthorization(request) }
  return { gate: 'refused', response: stagingAccessChallenge(request) }
}

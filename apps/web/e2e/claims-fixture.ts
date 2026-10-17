import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { type APIRequestContext, expect } from '@playwright/test'
import { rateLimitBucket, rateLimitBucketKey } from '../src/db/rate-limit-buckets'
import { deriveKey, RATE_LIMIT_KEY_LABEL } from '../src/lib/auth/keys'
import { claimRecipientRateLimitRules } from '../src/lib/claims/limits'
import {
  adminSuiteEnabled,
  LOCAL_EXPLORER_ENV,
  q,
  type SuiteServer,
  workerD1
} from './admin-fixture'
import { listingStatements, suiteCatalogStatements } from './fixture-seed'

/**
 * The claims suite (serpcompany/best.serp.co#67) runs on its own local Worker with its own D1,
 * started from the already-built Worker with `--test-scheduled` and the site's flags: claims,
 * the badge program (which removes a badge claimer, #66), and orders (#68) on, with no local
 * switch (#130, #133). Billing isn't configured here, so the dialog offers a payment but its
 * checkout answers 503; `billing.spec.ts` pays for a claim on the admin Worker. Never used
 * against a deployed Worker.
 *
 * `claims.spec.ts` and `claims-dialog.spec.ts` share the Worker and run in parallel, so they
 * reach its D1 through the Worker (`workerD1`), never the SQLite file (#200).
 */

const playwrightPort = Number(process.env.PLAYWRIGHT_PORT ?? 3100)

export const claimsSuiteEnabled = adminSuiteEnabled

export const claimsServer: SuiteServer = {
  // +3 admin, +4 media (#96), +5 account (#65), +6 badge program (#66).
  port: playwrightPort + 7,
  stateDirectory: resolve(tmpdir(), `best-serp-co-e2e-claims-${playwrightPort + 7}`)
}

/**
 * The claims Worker's `BETTER_AUTH_SECRET`, a fixed test value instead of an ephemeral one, so
 * the suites can name a rate-limit bucket (`resetClaimDomainBudget`). Local preview only.
 */
const CLAIMS_AUTH_SECRET = 'e2e-claims-suite-local-preview-only-secret'

export function claimsOrigin(): string {
  return `http://127.0.0.1:${claimsServer.port}`
}

export function claimsServerCommand(): string {
  const state = claimsServer.stateDirectory
  return [
    'cd ../..',
    `rm -rf "${state}"`,
    `mkdir -p "${state}"`,
    `HARNESS_D1_STATE_DIRECTORY="${state}" pnpm db:migrate:local`,
    // `workerD1` needs Wrangler's Local Explorer API: on by default, pinned on here.
    `HARNESS_D1_STATE_DIRECTORY="${state}" LOCAL_PREVIEW_VARS=BETTER_AUTH_SECRET=${CLAIMS_AUTH_SECRET} ${LOCAL_EXPLORER_ENV} PORT=${claimsServer.port} pnpm tsx scripts/d1-local-preview.ts`
  ].join(' && ')
}

/** Runs SQL on the claims Worker's D1 (see `workerD1`): the last statement's rows. */
export function claimsD1<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  return workerD1<T>(claimsServer, sql)
}

/** The category the claims suites' listings are filed under. */
const claimsCategory = {
  description: 'Tools for the claims suite.',
  name: 'E2E Claim Tools',
  slug: 'e2e-claim-tools'
} as const

/** The claims D1's publication state and category (each worker's `beforeAll` writes them). */
export async function seedClaimsCatalog(): Promise<void> {
  await workerD1(
    claimsServer,
    suiteCatalogStatements({ category: claimsCategory, checksum: 'e2e-claims' })
  )
}

/** A live listing on the claims D1, as the one-time import left it: no owner, no submission. */
export async function seedClaimsListing(listing: {
  content: string
  description: string
  id: string
  name: string
  slug: string
  website: string
}): Promise<void> {
  await workerD1(
    claimsServer,
    listingStatements({
      category: claimsCategory.slug,
      row: {
        ...listing,
        checksum: `e2e-${listing.id}`,
        published_at: '2026-05-16',
        source_identity: listing.id,
        source_kind: 'legacy-json-migration-v1'
      }
    })
  )
}

/** The registrable domain of every fixture website (`submit-fixture.ts`), so of every claim. */
const FIXTURE_DOMAIN = 'localtest.me'

/**
 * Empties the hourly cap on codes to the fixture websites' domain. Every claim in both suites
 * mails an address on `localtest.me`, so they all share one domain cap
 * (`CLAIM_RECIPIENT_LIMITS.domainHourly`): one run sends nearly all of it, and a retry or a
 * repeat would then never get its code (#200). Each test starts with it empty; the caps per
 * address, listing, account, and client address stay, and each test has its own of those.
 */
export async function resetClaimDomainBudget(): Promise<void> {
  const rule = claimRecipientRateLimitRules({
    address: `team@${FIXTURE_DOMAIN}`,
    domain: FIXTURE_DOMAIN,
    listingId: 'unused'
  }).find(candidate => candidate.key === FIXTURE_DOMAIN)
  if (!rule) throw new Error('The claim caps no longer count codes per domain.')
  // Named as `createAuthOperations` names it, under the key the app derives from the secret.
  const bucketKey = await rateLimitBucketKey(
    await deriveKey(CLAIMS_AUTH_SECRET, RATE_LIMIT_KEY_LABEL)
  )
  const bucket = await rateLimitBucket(bucketKey, rule)
  await claimsD1(`DELETE FROM auth_rate_limit_hits WHERE bucket = ${q(bucket)}`)
}

/**
 * The newest claim code emailed to `to`, once at least `count` have arrived. The Worker sends
 * email after its response (`waitUntil`), so a code can reach the dev outbox a moment after the
 * 201 that sent it.
 */
export async function claimCode(
  request: APIRequestContext,
  to: string,
  count = 1
): Promise<string> {
  let codes: string[] = []
  await expect
    .poll(
      async () => {
        const response = await request.get(`/api/dev/email-outbox?to=${encodeURIComponent(to)}`)
        const { messages } = (await response.json()) as { messages: Array<{ subject: string }> }
        // Newest first.
        codes = messages.flatMap(
          message => /^(\d{6}) is your SERP Best code to claim /u.exec(message.subject)?.[1] ?? []
        )
        return codes.length
      },
      { message: `claim codes emailed to ${to}` }
    )
    .toBeGreaterThanOrEqual(count)
  return codes[0] as string
}

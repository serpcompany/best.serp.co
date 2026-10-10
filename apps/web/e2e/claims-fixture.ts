import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { adminSuiteEnabled, localD1, runStatements, type SuiteServer } from './admin-fixture'
import { listingStatements, suiteCatalogStatements } from './fixture-seed'

/**
 * The claims suite (serpcompany/best.serp.co#67) runs on its own local Worker with its own D1,
 * started from the already-built Worker with `--test-scheduled` and the site's flags: claims,
 * the badge program (which removes a badge claimer, #66), and orders (#68) on, with no local
 * switch (#130, #133). Billing isn't configured here, so the dialog offers a payment but its
 * checkout answers 503; `billing.spec.ts` pays for a claim on the admin Worker. Never used
 * against a deployed Worker.
 */

const playwrightPort = Number(process.env.PLAYWRIGHT_PORT ?? 3100)

export const claimsSuiteEnabled = adminSuiteEnabled

export const claimsServer: SuiteServer = {
  // +3 admin, +4 media (#96), +5 account (#65), +6 badge program (#66).
  port: playwrightPort + 7,
  stateDirectory: resolve(tmpdir(), `best-serp-co-e2e-claims-${playwrightPort + 7}`)
}

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
    `HARNESS_D1_STATE_DIRECTORY="${state}" PORT=${claimsServer.port} pnpm tsx scripts/d1-local-preview.ts`
  ].join(' && ')
}

export function claimsD1<T = Record<string, unknown>>(sql: string): T[] {
  return localD1<T>(sql, claimsServer)
}

/** The category the claims suites' listings are filed under. */
const claimsCategory = {
  description: 'Tools for the claims suite.',
  name: 'E2E Claim Tools',
  slug: 'e2e-claim-tools'
} as const

/** The claims D1's publication state and category (each worker's `beforeAll` writes them). */
export function seedClaimsCatalog(): void {
  runStatements(
    suiteCatalogStatements({ category: claimsCategory, checksum: 'e2e-claims' }),
    claimsServer
  )
}

/** A live listing on the claims D1, as the one-time import left it: no owner, no submission. */
export function seedClaimsListing(listing: {
  content: string
  description: string
  id: string
  name: string
  slug: string
  website: string
}): void {
  runStatements(
    listingStatements({
      category: claimsCategory.slug,
      row: {
        ...listing,
        checksum: `e2e-${listing.id}`,
        published_at: '2026-05-16',
        source_identity: listing.id,
        source_kind: 'legacy-json-migration-v1'
      }
    }),
    claimsServer
  )
}

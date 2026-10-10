import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { adminSuiteEnabled, localD1, runStatements, type SuiteServer } from './admin-fixture'
import { listingStatements, suiteCatalogStatements } from './fixture-seed'

/**
 * Staging's password (serpcompany/best.serp.co#359) on a local Worker:
 * `playwright.staging-access.config.ts` serves the already-built Worker with
 * `LOCAL_STAGING_ACCESS=on`, so it serves as staging does (`servesAsStaging` in
 * `src/lib/environment/site-environment.ts`): every request needs the password except the
 * exemptions, a request with it is indexable, and every page writes
 * `https://staging.best.serp.co`. It has its own fresh D1 with one category and listing, which the
 * suite seeds. Never used against a deployed Worker: the smoke suite checks staging itself.
 *
 * It runs in its own Playwright run, after the main one (`pnpm test:e2e` runs both): a ninth
 * preview Worker beside the main run's eight exhausts the CI runner's memory (#111). It serves
 * the Worker the main run built.
 *
 * The password is a test value, never staging's own (`env.staging.vars` in `wrangler.jsonc`), so
 * the suite proves the Worker reads it from its vars.
 */

const playwrightPort = Number(process.env.PLAYWRIGHT_PORT ?? 3100)

/** Only when Playwright starts its own servers (the same rule as the admin suite). */
export const stagingAccessSuiteEnabled = adminSuiteEnabled

export const STAGING_ACCESS_TEST_PASSWORD = 'e2e-staging-password'

export const stagingAccessServer: SuiteServer = {
  // +1 and +2 are the Access-lock Workers, +3 admin, +4 media, +5 account, +6 badge, +7 claims,
  // +8 the billing suite's mocked Stripe API (`orders-worker.ts`).
  port: playwrightPort + 9,
  stateDirectory: resolve(tmpdir(), `best-serp-co-e2e-staging-access-${playwrightPort + 9}`)
}

export function stagingAccessOrigin(): string {
  return `http://127.0.0.1:${stagingAccessServer.port}`
}

/** Serves the built Worker on a fresh, migrated D1 of its own, as staging. */
export function stagingAccessServerCommand(): string {
  const state = stagingAccessServer.stateDirectory
  const vars = `LOCAL_STAGING_ACCESS=on,STAGING_BASIC_AUTH_PASSWORD=${STAGING_ACCESS_TEST_PASSWORD}`
  return [
    // The main run builds the Worker (`pnpm test:e2e`); alone, build it first (`pnpm build`).
    `test -f .open-next/worker.js || { echo 'No built Worker: pnpm build' >&2; exit 1; }`,
    'cd ../..',
    `rm -rf "${state}"`,
    `mkdir -p "${state}"`,
    `HARNESS_D1_STATE_DIRECTORY="${state}" pnpm db:migrate:local`,
    `HARNESS_D1_STATE_DIRECTORY="${state}" LOCAL_PREVIEW_VARS=${vars} PORT=${stagingAccessServer.port} pnpm tsx scripts/d1-local-preview.ts`
  ].join(' && ')
}

export const stagingAccessCategory = {
  description: 'Tools for the staging access suite.',
  name: 'E2E Staging Tools',
  slug: 'e2e-staging-tools'
} as const

export const stagingAccessListing = {
  name: 'Staging Fixture',
  slug: 'staging-fixture.example'
} as const

/** The suite's catalog: one category and one live listing in it, once (retries run it again). */
export function seedStagingAccessCatalog(): void {
  const [seeded] = localD1<{ count: number }>(
    "SELECT COUNT(*) AS count FROM listings WHERE id = 'e2e-staging-fixture'",
    stagingAccessServer
  )
  if (seeded?.count) return
  runStatements(
    [
      ...suiteCatalogStatements({ category: stagingAccessCategory, checksum: 'e2e-staging' }),
      ...listingStatements({
        category: stagingAccessCategory.slug,
        row: {
          checksum: 'e2e-staging-fixture',
          content: 'A listing for the staging access suite.',
          description: 'A fixture listing on the staging access Worker.',
          id: 'e2e-staging-fixture',
          name: stagingAccessListing.name,
          published_at: '2026-05-16',
          slug: stagingAccessListing.slug,
          source: 'admin',
          source_identity: 'e2e-staging-fixture',
          source_kind: 'e2e',
          website: `https://${stagingAccessListing.slug}/`
        }
      })
    ],
    stagingAccessServer
  )
}

/** `Authorization: Basic` for the suite's password, with any username (Ahrefs uses `staging`). */
export function stagingAuthorization(
  password = STAGING_ACCESS_TEST_PASSWORD,
  username = 'staging'
): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
}

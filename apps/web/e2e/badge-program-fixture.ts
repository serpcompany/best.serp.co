import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { adminSuiteEnabled, localD1, type SuiteServer } from './admin-fixture'
import { BILLING_PREVIEW_VARS } from './orders-worker'

/**
 * The badge program suite (serpcompany/best.serp.co#66) runs on its own local Worker with its
 * own D1, which `playwright.config.ts` starts from the already-built Worker: the suite
 * unpublishes listings and removes owners, and its scheduled runs check every listing in the
 * program, so it shares a D1 with no other suite. The program runs because
 * `features.badgeProgram` is on (#130), with no local switch, and the Worker is started with
 * `--test-scheduled` (`scripts/d1-local-preview.ts`), so the suite runs `scheduled()` through
 * `/__scheduled?cron=…`, as Wrangler's `wrangler dev --test-scheduled` does. Never used against
 * a deployed Worker.
 */

const playwrightPort = Number(process.env.PLAYWRIGHT_PORT ?? 3100)

/** Only when Playwright starts its own servers (the same rule as the admin suite). */
export const badgeSuiteEnabled = adminSuiteEnabled

export const badgeServer: SuiteServer = {
  // +3 is the admin suite's, +4 the media suite's (#96), +5 the account suite's (#65).
  port: playwrightPort + 6,
  stateDirectory: resolve(tmpdir(), `best-serp-co-e2e-badge-${playwrightPort + 6}`)
}

export function badgeOrigin(): string {
  return `http://127.0.0.1:${badgeServer.port}`
}

/**
 * Serves the built Worker on a fresh, migrated D1 of its own, with the site's flags. The hourly
 * trigger also runs the billing sweep (orders are on, #133), which needs the provider's secrets:
 * the mocked provider's (`orders-worker.ts`), though with no orders it calls nothing.
 */
export function badgeServerCommand(): string {
  const state = badgeServer.stateDirectory
  return [
    'cd ../..',
    `rm -rf "${state}"`,
    `mkdir -p "${state}"`,
    `HARNESS_D1_STATE_DIRECTORY="${state}" pnpm db:migrate:local`,
    `HARNESS_D1_STATE_DIRECTORY="${state}" LOCAL_PREVIEW_VARS=${BILLING_PREVIEW_VARS.join(',')} PORT=${badgeServer.port} pnpm tsx scripts/d1-local-preview.ts`
  ].join(' && ')
}

/** Runs SQL on the badge suite Worker's local D1 (see `localD1` in `admin-fixture.ts`). */
export function badgeD1<T = Record<string, unknown>>(sql: string): T[] {
  return localD1<T>(sql, badgeServer)
}

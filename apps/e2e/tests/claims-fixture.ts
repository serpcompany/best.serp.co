import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { adminSuiteEnabled, localD1, type SuiteServer } from './admin-fixture'

/**
 * The claims suite (serpcompany/best.serp.co#67) runs on its own local Worker with its own D1,
 * started from the already-built Worker with `--test-scheduled` and the site's flags (#130):
 * claims and the badge program (which removes a badge claimer, #66) on, with no local switch,
 * and orders (#68) off, so the claim dialog offers only the badge. Never used against a deployed
 * Worker.
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

/**
 * The local Worker `playwright.config.ts` starts for hosted listing media
 * (serpcompany/best.serp.co#95): the same build as the main preview, on its own throwaway local
 * D1 and R2, with the real catalog imported and then `scripts/seed-local-media.ts` run (a hosted
 * logo and featured image for one listing, a queued logo for another). The main preview's
 * catalog stays the pristine import.
 */
import { accessLockServersEnabled } from './access-lock-fixture'

const playwrightPort = Number(process.env.PLAYWRIGHT_PORT ?? 3100)
const mediaPort = playwrightPort + 4

/** Only when Playwright starts its own servers (not against an external or deployed Worker). */
export const mediaServerEnabled = accessLockServersEnabled
export const mediaOrigin = `http://127.0.0.1:${mediaPort}`

export const hostedMediaListing = {
  name: '123Movies Video Downloader',
  slug: '123movies-downloader'
}
export const queuedMediaListing = {
  name: 'Autoenhance.ai',
  slug: 'autoenhance.ai',
  source: 'https://unreachable.best-serp-co.test/logo.png'
}

export function mediaServerCommand(): string {
  const state = 'HARNESS_D1_STATE_DIRECTORY="$state"'
  return [
    'cd ../..',
    'state="$(mktemp -d)"',
    `${state} pnpm db:migrate:local`,
    `${state} pnpm db:import:local`,
    `${state} pnpm tsx scripts/seed-local-media.ts`,
    `${state} PORT=${mediaPort} pnpm tsx scripts/d1-local-preview.ts`
  ].join(' && ')
}

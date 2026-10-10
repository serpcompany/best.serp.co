/**
 * The local Worker `playwright.config.ts` starts for hosted listing media
 * (serpcompany/best.serp.co#95): the same build as the main preview, on its own throwaway local
 * D1 and R2, seeded with the fixtures (`pnpm db:seed:local` hosts every seeded logo and the detail
 * listing's featured image through the real ingestion path), then `scripts/seed-local-media.ts`
 * queues a logo for the logo-less listing. The main preview's D1 stays the plain seed.
 */
import { accessLockServersEnabled } from './access-lock-fixture'
import { seedListings } from './seed-facts'

const playwrightPort = Number(process.env.PLAYWRIGHT_PORT ?? 3100)
const mediaPort = playwrightPort + 4

/** Only when Playwright starts its own servers (not against an external or deployed Worker). */
export const mediaServerEnabled = accessLockServersEnabled
export const mediaOrigin = `http://127.0.0.1:${mediaPort}`

/** The seed hosts its logo and featured image. */
export const hostedMediaListing = seedListings.detail

/** The seed's logo-less listing, whose logo waits in the queue: its source never answers. */
export const queuedMediaListing = {
  ...seedListings.noLogo,
  source: 'https://unreachable.best-serp-co.test/logo.png'
} as const

export function mediaServerCommand(): string {
  const state = 'HARNESS_D1_STATE_DIRECTORY="$state"'
  return [
    'cd ../..',
    'state="$(mktemp -d)"',
    `${state} pnpm db:seed:local`,
    `${state} pnpm tsx scripts/seed-local-media.ts`,
    `${state} PORT=${mediaPort} pnpm tsx scripts/d1-local-preview.ts`
  ].join(' && ')
}

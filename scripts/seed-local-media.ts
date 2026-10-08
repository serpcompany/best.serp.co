import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getPlatformProxy } from 'wrangler'
import { createMediaOperations } from '../apps/web/src/db/media-operations'
import { buildQueueMediaPlans } from '../apps/web/src/db/media-plans'
import { validateCanonicalLocalConfig } from './d1-local-config'
import { configuredFreshD1StateRoot } from './d1-local-state'
import { solidPng } from './fixtures/solid-png'
import { project } from './project'

/**
 * Seeds hosted listing media into a throwaway local Wrangler state for the e2e media server
 * (`apps/e2e/tests/media-fixture.ts`, serpcompany/best.serp.co#95). It runs the real ingestion
 * path (byte sniffing, content-addressed key, R2 write with its cache policy, D1 plan with a
 * catalog publication) against local D1 and R2; only the source fetch is answered from memory,
 * with tiny generated PNGs. Local state only: the config check refuses anything else.
 */

export const MEDIA_FIXTURE_ORIGIN = 'https://fixtures.best-serp-co.test'
/** A listing that gets a hosted logo and featured image. */
export const HOSTED_MEDIA_LISTING = '123movies-downloader'
/** A listing whose logo waits in the queue (its source is unreachable). */
export const QUEUED_MEDIA_LISTING = 'autoenhance.ai'
export const QUEUED_LOGO_SOURCE = 'https://unreachable.best-serp-co.test/logo.png'

export const mediaFixtures = {
  [`${MEDIA_FIXTURE_ORIGIN}/logo.png`]: solidPng(512, 512, [16, 185, 129]),
  [`${MEDIA_FIXTURE_ORIGIN}/featured.png`]: solidPng(1200, 630, [59, 130, 246])
}

const fixtureFetch: typeof fetch = async input => {
  const url = input instanceof Request ? input.url : String(input)
  const body = mediaFixtures[url]
  if (!body) throw new TypeError(`fetch failed: ${url}`)
  return new Response(new Uint8Array(body), { headers: { 'Content-Type': 'image/png' } })
}

async function seed(): Promise<void> {
  validateCanonicalLocalConfig()
  const { dispose, env } = await getPlatformProxy<{ DB: D1Database; MEDIA: R2Bucket }>({
    configPath: project.wranglerConfigPath,
    // `--persist-to <root>` stores under <root>/v3, which is what getPlatformProxy takes.
    persist: { path: resolve(configuredFreshD1StateRoot(), 'v3') }
  })
  try {
    const operations = createMediaOperations({
      bucket: env.MEDIA,
      clock: () => new Date(),
      db: env.DB,
      fetcher: fixtureFetch
    })
    const id = async (slug: string) => {
      const row = await env.DB.prepare('SELECT id FROM listings WHERE slug=?').bind(slug).first<{
        id: string
      }>()
      if (!row) throw new Error(`Listing ${slug} is not in the local catalog.`)
      return row.id
    }
    const hosted = await id(HOSTED_MEDIA_LISTING)
    for (const [kind, file] of [
      ['logo', 'logo.png'],
      ['image', 'featured.png']
    ] as const) {
      const outcome = await operations.hostListingMedia({
        actor: 'e2e-seed',
        kind,
        listingId: hosted,
        sortOrder: 0,
        sourceUrl: `${MEDIA_FIXTURE_ORIGIN}/${file}`,
        workflow: 'e2e/seed-local-media'
      })
      if (outcome.status !== 'hosted')
        throw new Error(`Seeding the ${kind} failed: ${outcome.code}.`)
    }
    const queued = await id(QUEUED_MEDIA_LISTING)
    const now = new Date().toISOString()
    await env.DB.batch([
      env.DB.prepare("DELETE FROM listing_media WHERE listing_id=? AND kind='logo'").bind(queued),
      ...buildQueueMediaPlans({
        kind: 'logo',
        now,
        sortOrder: 0,
        sourceUrl: QUEUED_LOGO_SOURCE,
        target: { listingId: queued }
      }).map(plan => env.DB.prepare(plan.sql).bind(...plan.params))
    ])
    console.log(
      `Seeded hosted media for ${HOSTED_MEDIA_LISTING} and a queued logo for ${QUEUED_MEDIA_LISTING}.`
    )
  } finally {
    await dispose()
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  seed().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}

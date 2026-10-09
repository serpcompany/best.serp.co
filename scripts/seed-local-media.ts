import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getPlatformProxy } from 'wrangler'
import { seedListingId } from '../apps/web/e2e/fixture-seed'
import { queuedMediaListing } from '../apps/web/e2e/media-fixture'
import { createMediaOperations } from '../apps/web/src/db/media-operations'
import { buildQueueMediaPlans } from '../apps/web/src/db/media-plans'
import { validateCanonicalLocalConfig } from './d1-local-config'
import { configuredFreshD1StateRoot } from './d1-local-state'
import { project } from './project'

/**
 * Hosts listing media in local state through the real ingestion path (byte sniffing,
 * content-addressed key, R2 write with its cache policy, D1 plan with a catalog publication),
 * against local D1 and R2; only the source fetch is answered from memory, with generated PNGs.
 * `pnpm db:seed:local` (`d1-local-seed.ts`) hosts the fixture seed's logos with it. Run directly
 * on a seeded D1, it adds the e2e media server's queued logo (`apps/web/e2e/media-fixture.ts`,
 * serpcompany/best.serp.co#95). Local state only: the config check refuses anything else, and
 * no binding may reach a remote resource.
 */

export interface LocalPlatform {
  DB: D1Database
  MEDIA: R2Bucket
}

/** Answers each fixture URL with its bytes; any other URL fails as a network error would. */
export function fixtureFetch(fixtures: Readonly<Record<string, Uint8Array>>): typeof fetch {
  return async input => {
    const url = input instanceof Request ? input.url : String(input)
    const body = fixtures[url]
    if (!body) throw new TypeError(`fetch failed: ${url}`)
    return new Response(new Uint8Array(body), { headers: { 'Content-Type': 'image/png' } })
  }
}

/** Runs `use` with the local Worker's D1 and R2 bindings, on the canonical local state. */
export async function withLocalPlatform<T>(use: (env: LocalPlatform) => Promise<T>): Promise<T> {
  validateCanonicalLocalConfig()
  const { dispose, env } = await getPlatformProxy<LocalPlatform>({
    configPath: project.wranglerConfigPath,
    // `--persist-to <root>` stores under <root>/v3, which is what getPlatformProxy takes.
    persist: { path: resolve(configuredFreshD1StateRoot(), 'v3') },
    remoteBindings: false
  })
  try {
    return await use(env)
  } finally {
    await dispose()
  }
}

export interface ListingImage {
  bytes: Uint8Array
  kind: 'image' | 'logo'
  listingId: string
  sourceUrl: string
}

/** Hosts each image on its listing (slot 0), in order; any image that fails stops the run. */
export async function hostListingImages(
  env: LocalPlatform,
  images: readonly ListingImage[],
  options: { actor: string; clock?: () => Date; workflow: string }
): Promise<void> {
  const operations = createMediaOperations({
    bucket: env.MEDIA,
    clock: options.clock ?? (() => new Date()),
    db: env.DB,
    fetcher: fixtureFetch(Object.fromEntries(images.map(image => [image.sourceUrl, image.bytes])))
  })
  for (const image of images) {
    const outcome = await operations.hostListingMedia({
      actor: options.actor,
      kind: image.kind,
      listingId: image.listingId,
      sortOrder: 0,
      sourceUrl: image.sourceUrl,
      workflow: options.workflow
    })
    if (outcome.status !== 'hosted') {
      throw new Error(`Hosting ${image.sourceUrl} failed: ${outcome.code}.`)
    }
  }
}

/** Queues a logo for the seed's logo-less listing, from a source that never answers. */
async function queueUnreachableLogo(): Promise<void> {
  await withLocalPlatform(async env => {
    const listingId = seedListingId(queuedMediaListing.slug)
    const row = await env.DB.prepare('SELECT id FROM listings WHERE id=?').bind(listingId).first()
    if (!row) {
      throw new Error(`Listing ${queuedMediaListing.slug} is not seeded; run pnpm db:seed:local.`)
    }
    await env.DB.batch([
      env.DB.prepare("DELETE FROM listing_media WHERE listing_id=? AND kind='logo'").bind(
        listingId
      ),
      ...buildQueueMediaPlans({
        kind: 'logo',
        now: new Date().toISOString(),
        sortOrder: 0,
        sourceUrl: queuedMediaListing.source,
        target: { listingId }
      }).map(plan => env.DB.prepare(plan.sql).bind(...plan.params))
    ])
    console.log(`Queued an unreachable logo for ${queuedMediaListing.slug}.`)
  })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  queueUnreachableLogo().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}

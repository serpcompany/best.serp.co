import { describe, expect, it } from 'vitest'
import { MEDIA_CACHE_CONTROL, sha256Hex } from './media-keys'
import { createMediaOperations } from './media-operations'
import { buildQueueMediaPlans } from './media-plans'
import { imageResponse, memoryBucket, pngBytes, routedFetch } from './media-test-support'
import { insertPublishedListing, SqliteD1 } from './test-support'

const listingId = 'lst_ops'
const slug = 'ops.example'
const submissionId = 'sub_ops'
const logo = 'https://ops.example/logo.png'
const social = 'https://ops.example/og.png'

function fixture(routes: Parameters<typeof routedFetch>[0], start = '2026-10-06T12:00:00.000Z') {
  const sqlite = new SqliteD1()
  sqlite.database.exec(`
    INSERT INTO categories (slug, name, description, sort_order, is_active)
      VALUES ('tools', 'Tools', 'Tools', 0, 1);
    INSERT INTO publication_state (id, version, checksum, published_at)
      VALUES (1, 1, 'before', '2026-01-01T00:00:00.000Z');
  `)
  insertPublishedListing(sqlite.database, {
    categoryIds: [1],
    content: null,
    description: 'Ops',
    displayOrder: 0,
    id: listingId,
    isFeatured: false,
    name: 'Ops',
    publishedAt: '2026-05-16',
    slug,
    website: 'https://ops.example/'
  })
  sqlite.database.exec(`
    INSERT INTO listing_submissions
      (id,slug,block_key,block_covers_subdomains,name,description,website,content,category_slug,
       logo_url,status,access_token_hash)
    VALUES ('${submissionId}','sub.example','sub.example',1,'Sub','d','https://sub.example/','c',
      'tools','${logo}','pending_badge','hash');
  `)
  let now = new Date(start)
  const bucket = memoryBucket()
  const events: Array<Record<string, unknown>> = []
  const operations = createMediaOperations({
    bucket,
    clock: () => now,
    db: sqlite.asD1Database(),
    fetcher: routedFetch(routes),
    observe: event => events.push(event)
  })
  return {
    advance(minutes: number) {
      now = new Date(now.getTime() + minutes * 60_000)
    },
    bucket,
    events,
    operations,
    rows: (sql: string) => sqlite.database.prepare(sql).all(),
    sqlite
  }
}

describe('media operations', () => {
  it('hosts an admin’s new listing logo and turns the catalog over', async () => {
    const png = pngBytes(256, 256)
    const { bucket, events, operations, rows } = fixture({ [logo]: imageResponse(png) })
    const key = `best.serp.co/listings/${slug}/logo/${(await sha256Hex(png)).slice(0, 16)}.png`
    expect(
      await operations.hostListingMedia({
        actor: 'admin@example.com',
        kind: 'logo',
        listingId,
        sortOrder: 0,
        sourceUrl: logo,
        workflow: 'app/admin'
      })
    ).toEqual({ key, status: 'hosted' })
    expect(bucket.objects.get(key)?.options.httpMetadata).toEqual({
      cacheControl: MEDIA_CACHE_CONTROL,
      contentType: 'image/png'
    })
    expect(rows('SELECT kind,url,media_key,width FROM listing_media')).toEqual([
      { kind: 'logo', media_key: key, url: logo, width: 256 }
    ])
    expect(rows('SELECT version,manifest_id FROM publication_state')).toEqual([
      { manifest_id: `listing-media-${listingId}-v2`, version: 2 }
    ])
    expect(events).toEqual([
      { event: 'media_ingest', host: 'ops.example', outcome: 'hosted', target: 'listing' }
    ])
  })

  it('queues a source that is down and fails one that can never be an image', async () => {
    const { bucket, operations, rows } = fixture({
      [logo]: () => new Response('busy', { status: 503 }),
      [social]: imageResponse(new TextEncoder().encode('<svg onload="x"/>'), 'image/svg+xml')
    })
    expect(
      await operations.hostSubmissionMedia({
        kind: 'logo',
        sortOrder: 0,
        sourceUrl: logo,
        submissionId
      })
    ).toEqual({ code: 'http_503', status: 'pending' })
    expect(
      await operations.hostSubmissionMedia({
        kind: 'image',
        sortOrder: 0,
        sourceUrl: social,
        submissionId
      })
    ).toEqual({ code: 'svg', status: 'failed' })
    expect(bucket.objects.size).toBe(0)
    expect(await operations.submissionMedia(submissionId)).toEqual([
      {
        attempts: 1,
        kind: 'image',
        lastError: 'svg',
        mediaKey: null,
        nextAttemptAt: null,
        sortOrder: 0,
        sourceUrl: social,
        status: 'failed'
      },
      {
        attempts: 1,
        kind: 'logo',
        lastError: 'http_503',
        mediaKey: null,
        nextAttemptAt: '2026-10-06T12:15:00.000Z',
        sortOrder: 0,
        sourceUrl: logo,
        status: 'pending'
      }
    ])
    expect(rows('SELECT COUNT(*) AS count FROM listing_media')).toEqual([{ count: 0 }])
  })

  it('retries due slots from the cron until they are hosted, never before they are due', async () => {
    let available = false
    const png = pngBytes(1200, 630)
    const { advance, bucket, operations, rows, sqlite } = fixture({
      [logo]: () => (available ? imageResponse(png) : new Response('down', { status: 502 })),
      [social]: () => imageResponse(png)
    })
    const db = sqlite.asD1Database()
    for (const plan of buildQueueMediaPlans({
      kind: 'image',
      now: '2026-10-06T12:00:00.000Z',
      sortOrder: 0,
      sourceUrl: social,
      target: { listingId }
    })) {
      await db
        .prepare(plan.sql)
        .bind(...plan.params)
        .run()
    }
    expect(
      await operations.hostSubmissionMedia({
        kind: 'logo',
        sortOrder: 0,
        sourceUrl: logo,
        submissionId
      })
    ).toEqual({ code: 'http_502', status: 'pending' })

    expect(await operations.processDueMedia()).toEqual({
      failed: 0,
      hosted: 1,
      processed: 1,
      retried: 0
    })
    expect(rows('SELECT kind,media_key IS NOT NULL AS hosted FROM listing_media')).toEqual([
      { hosted: 1, kind: 'image' }
    ])
    expect(await operations.listingMediaQueue(listingId)).toEqual([])

    advance(5)
    expect((await operations.processDueMedia()).processed).toBe(0)
    advance(10)
    available = true
    expect(await operations.processDueMedia()).toEqual({
      failed: 0,
      hosted: 1,
      processed: 1,
      retried: 0
    })
    expect(await operations.submissionMedia(submissionId)).toMatchObject([
      { attempts: 2, kind: 'logo', status: 'hosted' }
    ])
    expect(bucket.objects.size).toBe(2)
  })
})

import { describe, expect, it } from 'vitest'
import { MEDIA_CACHE_CONTROL, SUBMISSION_MEDIA_CACHE_CONTROL, sha256Hex } from './media-keys'
import { createMediaOperations, queueMedia } from './media-operations'
import { buildQueueMediaPlans } from './media-plans'
import { imageResponse, memoryBucket, pngBytes, routedFetch } from './media-test-support'
import type { StatementPlan } from './plan-support'
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
      retried: 0,
      superseded: 0
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
      retried: 0,
      superseded: 0
    })
    expect(await operations.submissionMedia(submissionId)).toMatchObject([
      { attempts: 2, kind: 'logo', status: 'hosted' }
    ])
    expect(bucket.objects.size).toBe(2)
  })

  it('drops a cron result when an admin hosted another logo while it fetched (#96 review B1)', async () => {
    const a = pngBytes(64, 64)
    const b = pngBytes(96, 96)
    const adminLogo = 'https://ops.example/b.png'
    let edit: () => Promise<unknown> = async () => undefined
    const { operations, rows, sqlite } = fixture({
      // The cron's fetch of A is in flight when the admin's edit lands.
      [logo]: async () => {
        await edit()
        return imageResponse(a)
      },
      [adminLogo]: () => imageResponse(b)
    })
    await runPlans(
      sqlite,
      buildQueueMediaPlans({
        kind: 'logo',
        now: '2026-10-06T12:00:00.000Z',
        sortOrder: 0,
        sourceUrl: logo,
        target: { listingId }
      })
    )
    edit = () =>
      operations.hostListingMedia({
        actor: 'admin@example.com',
        kind: 'logo',
        listingId,
        sortOrder: 0,
        sourceUrl: adminLogo,
        workflow: 'app/admin'
      })
    expect(await operations.processDueMedia()).toEqual({
      failed: 0,
      hosted: 0,
      processed: 1,
      retried: 0,
      superseded: 1
    })
    const bKey = `best.serp.co/listings/${slug}/logo/${(await sha256Hex(b)).slice(0, 16)}.png`
    expect(rows("SELECT url,media_key FROM listing_media WHERE kind='logo'")).toEqual([
      { media_key: bKey, url: adminLogo }
    ])
    expect(rows('SELECT COUNT(*) AS count FROM media_ingestions')).toEqual([{ count: 0 }])
    expect(rows('SELECT version FROM publication_state')).toEqual([{ version: 2 }])
  })

  it('drops a cron failure when the slot was replaced meanwhile, never re-creating it', async () => {
    const b = pngBytes(96, 96)
    const adminLogo = 'https://ops.example/b.png'
    let edit: () => Promise<unknown> = async () => undefined
    const { operations, rows, sqlite } = fixture({
      [logo]: async () => {
        await edit()
        return new Response('busy', { status: 503 })
      },
      [adminLogo]: () => imageResponse(b)
    })
    await runPlans(
      sqlite,
      buildQueueMediaPlans({
        kind: 'logo',
        now: '2026-10-06T12:00:00.000Z',
        sortOrder: 0,
        sourceUrl: logo,
        target: { listingId }
      })
    )
    edit = () =>
      operations.hostListingMedia({
        actor: 'admin@example.com',
        kind: 'logo',
        listingId,
        sortOrder: 0,
        sourceUrl: adminLogo,
        workflow: 'app/admin'
      })
    expect((await operations.processDueMedia()).superseded).toBe(1)
    expect(rows("SELECT url FROM listing_media WHERE kind='logo'")).toEqual([{ url: adminLogo }])
    expect(rows('SELECT COUNT(*) AS count FROM media_ingestions')).toEqual([{ count: 0 }])
  })

  it('copies an approved submission’s hosted image into the listing path without refetching', async () => {
    const png = pngBytes(256, 256)
    const hash = (await sha256Hex(png)).slice(0, 16)
    const { bucket, operations, rows, sqlite } = fixture({ [logo]: imageResponse(png) })
    expect(
      await operations.hostSubmissionMedia({
        kind: 'logo',
        sortOrder: 0,
        sourceUrl: logo,
        submissionId
      })
    ).toEqual({
      key: `best.serp.co/submissions/${submissionId}/logo/${hash}.png`,
      status: 'hosted'
    })
    await runPlans(
      sqlite,
      buildQueueMediaPlans({
        copyFromKey: `best.serp.co/submissions/${submissionId}/logo/${hash}.png`,
        kind: 'logo',
        now: '2026-10-06T12:00:00.000Z',
        sortOrder: 0,
        sourceUrl: logo,
        target: { listingId }
      })
    )
    // The source answers once (it was used for the submission): a refetch would fail.
    expect((await operations.processListingMedia(listingId)).hosted).toBe(1)
    const listingKey = `best.serp.co/listings/${slug}/logo/${hash}.png`
    expect(rows('SELECT media_key FROM listing_media')).toEqual([{ media_key: listingKey }])
    expect(bucket.objects.get(listingKey)?.body).toEqual(png)
    // The submission is not finished yet, so its own copy stays.
    expect(await operations.forgetFinishedPendingMedia()).toBe(0)
    expect(bucket.objects.size).toBe(2)
  })

  it('never publishes a refetch the reviewer did not see when the copy is gone (#96 round 3 B1)', async () => {
    const reviewed = pngBytes(128, 128)
    const other = pngBytes(96, 96)
    let served = other
    const { bucket, operations, rows, sqlite } = fixture({ [logo]: () => imageResponse(served) })
    const reviewedKey = `best.serp.co/submissions/${submissionId}/logo/${(await sha256Hex(reviewed)).slice(0, 16)}.png`
    const queue = () =>
      runPlans(
        sqlite,
        buildQueueMediaPlans({
          copyFromKey: reviewedKey,
          kind: 'logo',
          now: '2026-10-06T12:00:00.000Z',
          sortOrder: 0,
          sourceUrl: logo,
          target: { listingId }
        })
      )
    // The reviewed object is gone and the source now serves other bytes: refused, recorded.
    await queue()
    expect(await operations.processDueMedia()).toMatchObject({ failed: 1, hosted: 0 })
    expect(rows('SELECT COUNT(*) AS count FROM listing_media')).toEqual([{ count: 0 }])
    expect(rows('SELECT status,last_error FROM media_ingestions')).toEqual([
      { last_error: 'reviewed_copy_changed', status: 'failed' }
    ])
    expect([...bucket.objects.keys()].filter(key => key.includes('/listings/'))).toEqual([])
    // A refetch of exactly the reviewed bytes may stand in for the gone copy.
    served = reviewed
    await queue()
    expect((await operations.processDueMedia()).hosted).toBe(1)
    expect(rows('SELECT media_key FROM listing_media')).toEqual([
      {
        media_key: `best.serp.co/listings/${slug}/logo/${(await sha256Hex(reviewed)).slice(0, 16)}.png`
      }
    ])
  })

  it('retries the copy, never refetching, while R2 is unavailable', async () => {
    const png = pngBytes(64, 64)
    const { bucket, operations, rows, sqlite } = fixture({ [logo]: imageResponse(png) })
    await operations.hostSubmissionMedia({
      kind: 'logo',
      sortOrder: 0,
      sourceUrl: logo,
      submissionId
    })
    const [submitted] = [...bucket.objects.keys()]
    // Reads fail (R2 unavailable); the scoped bucket reads through the same map.
    bucket.objects.get = () => {
      throw new Error('R2 unavailable')
    }
    await runPlans(
      sqlite,
      buildQueueMediaPlans({
        copyFromKey: submitted ?? '',
        kind: 'logo',
        now: '2026-10-06T12:00:00.000Z',
        sortOrder: 0,
        sourceUrl: logo,
        target: { listingId }
      })
    )
    expect(await operations.processListingMedia(listingId)).toMatchObject({ hosted: 0, retried: 1 })
    expect(
      rows('SELECT status,last_error FROM media_ingestions WHERE listing_id IS NOT NULL')
    ).toEqual([{ last_error: 'store_failed', status: 'pending' }])
  })

  it('deletes a finished submission’s images and stops retrying its slots (#96 review S1)', async () => {
    const png = pngBytes(64, 64)
    const { bucket, operations, rows, sqlite } = fixture({
      [logo]: imageResponse(png),
      [social]: () => new Response('busy', { status: 503 })
    })
    await operations.hostSubmissionMedia({
      kind: 'logo',
      sortOrder: 0,
      sourceUrl: logo,
      submissionId
    })
    await operations.hostSubmissionMedia({
      kind: 'image',
      sortOrder: 0,
      sourceUrl: social,
      submissionId
    })
    const listingObject = `best.serp.co/listings/${slug}/logo/${'1'.repeat(16)}.png`
    bucket.objects.set(listingObject, {
      body: png,
      options: { httpMetadata: { cacheControl: '', contentType: 'image/png' } }
    })
    expect(await operations.forgetFinishedPendingMedia()).toBe(0)
    sqlite.database
      .prepare("UPDATE listing_submissions SET status='rejected' WHERE id=?")
      .run(submissionId)
    expect(await operations.forgetFinishedPendingMedia()).toBe(2)
    expect(rows('SELECT COUNT(*) AS count FROM media_ingestions')).toEqual([{ count: 0 }])
    // Only the submission's object went; a listing's hosted image is never deleted.
    expect([...bucket.objects.keys()]).toEqual([listingObject])
  })
})

async function runPlans(sqlite: SqliteD1, plans: StatementPlan[]): Promise<void> {
  const db = sqlite.asD1Database()
  for (const plan of plans) {
    await db
      .prepare(plan.sql)
      .bind(...plan.params)
      .run()
  }
}

describe("a revision's logo (#96 review round 4, S1)", () => {
  const revisionId = 'rev_ops'
  const revised = 'https://ops.example/revised.png'

  function withRevision(routes: Parameters<typeof routedFetch>[0]) {
    const setup = fixture(routes)
    setup.sqlite.database.exec(`
      INSERT INTO users(id,name,email,email_verified) VALUES ('user_owner','','o@example.com',1);
      INSERT INTO listing_revisions
        (id,listing_id,author_user_id,status,base_checksum,name,description,category_slug,logo_url)
      VALUES ('${revisionId}','${listingId}','user_owner','pending_review','c','Ops','d','tools',
        '${revised}');
    `)
    return setup
  }

  it('is hosted under the revision, copied into the listing on approval, then forgotten', async () => {
    const png = pngBytes(128, 128)
    let calls = 0
    const { advance, bucket, events, operations, rows, sqlite } = withRevision({
      // Down at save time; the cron hosts it later, still under the revision.
      [revised]: () => {
        calls += 1
        return calls === 1 ? new Response('busy', { status: 503 }) : imageResponse(png)
      }
    })
    const hash = (await sha256Hex(png)).slice(0, 16)
    const pending = `best.serp.co/revisions/${revisionId}/logo/${hash}.png`
    expect(
      await operations.hostRevisionMedia({
        kind: 'logo',
        revisionId,
        sortOrder: 0,
        sourceUrl: revised
      })
    ).toEqual({ code: 'http_503', status: 'pending' })
    expect(events.at(-1)).toMatchObject({ outcome: 'http_503', target: 'revision' })
    advance(15)
    expect(await operations.processDueMedia()).toMatchObject({ hosted: 1 })
    expect(rows('SELECT revision_id,status,media_key FROM media_ingestions')).toEqual([
      { media_key: pending, revision_id: revisionId, status: 'hosted' }
    ])
    // Pending: a short cache, so a withdrawn revision's logo leaves the media host promptly.
    expect(bucket.objects.get(pending)?.options.httpMetadata.cacheControl).toBe(
      SUBMISSION_MEDIA_CACHE_CONTROL
    )
    // Approval queued a copy of exactly the reviewed key; the listing gets the same bytes.
    await queueMedia(sqlite.asD1Database(), {
      copyFromKey: pending,
      kind: 'logo',
      now: '2026-10-06T12:15:00.000Z',
      sortOrder: 0,
      sourceUrl: revised,
      target: { listingId }
    })
    sqlite.database.exec(`UPDATE listing_revisions SET status='approved'`)
    expect(await operations.forgetFinishedPendingMedia()).toBe(0)
    expect(await operations.processListingMedia(listingId)).toMatchObject({ hosted: 1 })
    const listingKey = `best.serp.co/listings/${slug}/logo/${hash}.png`
    expect(rows("SELECT url,media_key FROM listing_media WHERE kind='logo'")).toEqual([
      { media_key: listingKey, url: revised }
    ])
    expect(calls).toBe(2)
    // Once copied, the revision's object and slot go.
    expect(await operations.forgetFinishedPendingMedia()).toBe(1)
    expect(bucket.objects.has(pending)).toBe(false)
    expect(bucket.objects.has(listingKey)).toBe(true)
    expect(rows('SELECT COUNT(*) AS count FROM media_ingestions')).toEqual([{ count: 0 }])
  })

  it('needs no copy when the listing already hosts that source', async () => {
    const png = pngBytes(96, 96)
    const { operations, rows } = withRevision({ [logo]: imageResponse(png) })
    const hosted = await operations.hostListingMedia({
      actor: 'admin@example.com',
      kind: 'logo',
      listingId,
      sortOrder: 0,
      sourceUrl: logo,
      workflow: 'app/admin'
    })
    expect(hosted.status).toBe('hosted')
    expect(
      await operations.hostRevisionMedia({
        kind: 'logo',
        revisionId,
        sortOrder: 0,
        sourceUrl: logo
      })
    ).toEqual(hosted)
    expect(rows('SELECT COUNT(*) AS count FROM media_ingestions')).toEqual([{ count: 0 }])
    await expect(
      operations.hostRevisionMedia({
        kind: 'logo',
        revisionId: 'rev_missing',
        sortOrder: 0,
        sourceUrl: revised
      })
    ).rejects.toThrow(/Revision not found/u)
  })
})

describe('a pending image replaced before review (#96 review round 5, S1)', () => {
  const first = 'https://ops.example/first.png'
  const second = 'https://ops.example/second.png'
  const same = 'https://ops.example/same-bytes.png'
  const broken = 'https://ops.example/broken.png'

  it('deletes the superseded submission object once the new one is hosted', async () => {
    const a = pngBytes(100, 100)
    const b = pngBytes(110, 110)
    const { bucket, operations, rows } = fixture({
      [broken]: () => new Response('gone', { status: 404 }),
      [first]: () => imageResponse(a),
      [same]: () => imageResponse(a),
      [second]: () => imageResponse(b)
    })
    const host = (sourceUrl: string) =>
      operations.hostSubmissionMedia({ kind: 'logo', sortOrder: 0, sourceUrl, submissionId })
    const keyA = ((await host(first)) as { key: string }).key
    expect(bucket.objects.has(keyA)).toBe(true)
    // The same bytes from another URL keep the same key: nothing is deleted.
    expect(await host(same)).toEqual({ key: keyA, status: 'hosted' })
    expect(bucket.objects.has(keyA)).toBe(true)
    // Another image: the never-reviewed first one leaves the bucket after the new row is written.
    const keyB = ((await host(second)) as { key: string }).key
    expect(keyB).not.toBe(keyA)
    expect(bucket.objects.has(keyA)).toBe(false)
    expect(bucket.objects.has(keyB)).toBe(true)
    expect(rows('SELECT media_key FROM media_ingestions')).toEqual([{ media_key: keyB }])
    // A replacement that cannot be hosted still drops the superseded object (the slot names none).
    expect(await host(broken)).toEqual({ code: 'http_404', status: 'failed' })
    expect(bucket.objects.has(keyB)).toBe(false)
  })

  it('keeps an object a listing slot still waits to copy', async () => {
    const { bucket, operations, sqlite } = fixture({
      [first]: () => imageResponse(pngBytes(100, 100)),
      [second]: () => imageResponse(pngBytes(120, 120))
    })
    const host = (sourceUrl: string) =>
      operations.hostSubmissionMedia({ kind: 'logo', sortOrder: 0, sourceUrl, submissionId })
    const keyA = ((await host(first)) as { key: string }).key
    await queueMedia(sqlite.asD1Database(), {
      copyFromKey: keyA,
      kind: 'logo',
      now: '2026-10-06T12:00:00.000Z',
      sortOrder: 0,
      sourceUrl: first,
      target: { listingId }
    })
    await host(second)
    expect(bucket.objects.has(keyA)).toBe(true)
  })

  it("deletes a revision's superseded logo, also when it falls back to the listing's", async () => {
    const revisionId = 'rev_swap'
    const { bucket, operations, rows, sqlite } = fixture({
      [first]: () => imageResponse(pngBytes(100, 100)),
      [logo]: () => imageResponse(pngBytes(90, 90))
    })
    sqlite.database.exec(`
      INSERT INTO users(id,name,email,email_verified) VALUES ('user_owner','','o@example.com',1);
      INSERT INTO listing_revisions
        (id,listing_id,author_user_id,status,base_checksum,name,description,category_slug,logo_url)
      VALUES ('${revisionId}','${listingId}','user_owner','pending_review','c','Ops','d','tools',
        '${first}');
    `)
    await operations.hostListingMedia({
      actor: 'admin@example.com',
      kind: 'logo',
      listingId,
      sortOrder: 0,
      sourceUrl: logo,
      workflow: 'app/admin'
    })
    const pending = (await operations.hostRevisionMedia({
      kind: 'logo',
      revisionId,
      sortOrder: 0,
      sourceUrl: first
    })) as { key: string }
    expect(pending.key).toMatch(/^best\.serp\.co\/revisions\/rev_swap\//u)
    // The owner goes back to the listing's own logo: the revision's copy is no longer named.
    await operations.hostRevisionMedia({ kind: 'logo', revisionId, sortOrder: 0, sourceUrl: logo })
    expect(bucket.objects.has(pending.key)).toBe(false)
    expect(rows('SELECT COUNT(*) AS count FROM media_ingestions')).toEqual([{ count: 0 }])
  })
})

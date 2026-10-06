import type { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { type HostedMedia, type MediaOwner, mediaKey } from './media-keys'
import {
  buildClaimMediaPlans,
  buildHostListingMediaPlans,
  buildQueueMediaPlans,
  buildRecordClaimedFailurePlans,
  buildRecordMediaFailurePlans,
  buildRecordSubmissionMediaPlans,
  MAX_MEDIA_ATTEMPTS,
  MEDIA_RETRY_DELAYS_MINUTES,
  type MediaClaim,
  mediaClaimLease,
  nextMediaAttemptAt,
  selectDueMediaPlan,
  selectListingMediaContextPlan,
  selectListingMediaQueuePlan,
  selectSubmissionMediaPlan
} from './media-plans'
import {
  count,
  execute,
  NOW,
  planDatabase,
  publication,
  publicationState,
  query,
  seedLiveListing
} from './plan-test-support'
import { buildApproveSubmissionPlans } from './submission-plans'

const listingId = 'lst_media'
const slug = 'lst_media.example'
const submissionId = 'sub_media'

function hosted(
  kind: 'image' | 'logo',
  hash = 'a',
  sourceUrl = 'https://assets.example/new.png',
  owner: MediaOwner = { slug }
) {
  const sha256 = hash.repeat(64)
  return {
    bytes: 2048,
    contentType: 'image/png',
    height: 256,
    key: mediaKey({ format: 'png', kind, sha256, ...owner }),
    sha256,
    sourceUrl,
    width: 256
  } satisfies HostedMedia
}

/** A submission's hosted image (`best.serp.co/submissions/<id>/…`). */
function pendingCopy(kind: 'image' | 'logo', hash: string, sourceUrl: string) {
  return hosted(kind, hash, sourceUrl, { submissionId })
}

function seededDatabase(): DatabaseSync {
  const db = planDatabase()
  seedLiveListing(db, listingId)
  return db
}

function seedSubmission(db: DatabaseSync, logoUrl = 'https://example.com/logo.png'): void {
  db.prepare(
    `INSERT INTO listing_submissions
      (id,slug,block_key,block_covers_subdomains,name,description,website,content,category_slug,
       logo_url,status,access_token_hash,badge_verified_at,owner_user_id,plan)
     VALUES (?,'example.com','example.com',1,'Example','Description','https://example.com/',
       'Content','tools',?,'verified','hash','2026-08-01T00:00:00.000Z','user_owner','free')`
  ).run(submissionId, logoUrl)
}

function slots(db: DatabaseSync): unknown[] {
  return db
    .prepare(
      `SELECT listing_id,submission_id,kind,sort_order,source_url,status,attempts,next_attempt_at,
        last_error,media_key FROM media_ingestions ORDER BY id`
    )
    .all()
}

function approve(db: DatabaseSync, expectedImageKey?: string | null): void {
  execute(
    db,
    buildApproveSubmissionPlans({
      afterChecksum: 'after',
      affectedRoute: '/products/example.com/',
      beforeChecksum: 'before',
      expectedContentVersion: 1,
      expectedImageKey,
      listingId: 'lst_approved',
      manifestId: `verified-submission-${submissionId}`,
      now: NOW,
      reviewer: 'reviewer',
      runId: `submission_publish_${submissionId}`,
      submissionId,
      version: 1
    })
  )
}

describe('media retry schedule', () => {
  it('backs off after each failed attempt and stops after the last delay', () => {
    expect(MAX_MEDIA_ATTEMPTS).toBe(MEDIA_RETRY_DELAYS_MINUTES.length + 1)
    expect(nextMediaAttemptAt(NOW, 1)).toBe('2026-10-06T12:15:00.000Z')
    expect(nextMediaAttemptAt(NOW, 2)).toBe('2026-10-06T13:00:00.000Z')
    expect(nextMediaAttemptAt(NOW, MEDIA_RETRY_DELAYS_MINUTES.length)).toBe(
      '2026-10-08T12:00:00.000Z'
    )
    expect(nextMediaAttemptAt(NOW, MAX_MEDIA_ATTEMPTS)).toBeNull()
    expect(() => nextMediaAttemptAt(NOW, 0)).toThrow(/at least one/u)
    expect(() => nextMediaAttemptAt('2026-10-06', 1)).toThrow(/ISO instant/u)
  })
})

describe('hosting a listing slot', () => {
  it('writes the key and metadata, clears the queue, and advances the catalog version', () => {
    const db = seededDatabase()
    execute(
      db,
      buildQueueMediaPlans({
        kind: 'logo',
        now: NOW,
        sortOrder: 0,
        sourceUrl: 'https://assets.example/new.png',
        target: { listingId }
      })
    )
    const pub = publication('listing-media')
    execute(
      db,
      buildHostListingMediaPlans({
        kind: 'logo',
        listingId,
        media: hosted('logo'),
        publication: pub,
        sortOrder: 0
      })
    )
    expect(
      db
        .prepare(
          `SELECT kind,url,media_key,sha256,content_type,bytes,width,height FROM listing_media
           WHERE listing_id=? ORDER BY kind,sort_order`
        )
        .all(listingId)
    ).toEqual([
      {
        bytes: null,
        content_type: null,
        height: null,
        kind: 'image',
        media_key: null,
        sha256: null,
        url: 'https://assets.example/image.png',
        width: null
      },
      {
        bytes: 2048,
        content_type: 'image/png',
        height: 256,
        kind: 'logo',
        media_key: hosted('logo').key,
        sha256: 'a'.repeat(64),
        url: 'https://assets.example/new.png',
        width: 256
      }
    ])
    expect(slots(db)).toEqual([])
    expect(publicationState(db)).toEqual({ checksum: pub.afterChecksum, version: 2 })
    expect(query(db, selectListingMediaContextPlan(listingId))).toEqual([
      { checksum: pub.afterChecksum, id: listingId, slug, version: 2 }
    ])
  })

  it('refuses a key of the wrong kind or site, and a listing that does not exist', () => {
    const db = seededDatabase()
    const plans = (media: HostedMedia, id = listingId) =>
      buildHostListingMediaPlans({
        kind: 'logo',
        listingId: id,
        media,
        publication: publication('listing-media'),
        sortOrder: 0
      })
    expect(() => plans(hosted('image'))).toThrow(/not a hosted logo key/u)
    expect(() => plans({ ...hosted('logo'), key: 'serp.co/logo.png' })).toThrow(/not a hosted/u)
    expect(() => execute(db, plans(hosted('logo'), 'lst_missing'))).toThrow(/malformed JSON/u)
    expect(publicationState(db).version).toBe(1)
  })
})

describe('the media queue', () => {
  it('keeps retryable failures pending with backoff and fails the rest with a reason', () => {
    const db = seededDatabase()
    const fail = (attempts: number, retryable: boolean, code = 'site_unreachable') =>
      execute(
        db,
        buildRecordMediaFailurePlans({
          attempts,
          code,
          kind: 'image',
          now: NOW,
          retryable,
          sortOrder: 1,
          sourceUrl: 'https://assets.example/og.png',
          target: { listingId }
        })
      )
    fail(1, true)
    expect(slots(db)).toEqual([
      {
        attempts: 1,
        kind: 'image',
        last_error: 'site_unreachable',
        listing_id: listingId,
        media_key: null,
        next_attempt_at: '2026-10-06T12:15:00.000Z',
        sort_order: 1,
        source_url: 'https://assets.example/og.png',
        status: 'pending',
        submission_id: null
      }
    ])
    fail(MAX_MEDIA_ATTEMPTS, true)
    expect(slots(db)).toMatchObject([
      { attempts: MAX_MEDIA_ATTEMPTS, next_attempt_at: null, status: 'failed' }
    ])
    fail(1, false, 'svg')
    expect(slots(db)).toMatchObject([
      { last_error: 'svg', next_attempt_at: null, status: 'failed' }
    ])
    expect(query(db, selectListingMediaQueuePlan(listingId))).toMatchObject([
      { kind: 'image', last_error: 'svg', status: 'failed' }
    ])
    expect(() => fail(1, false, ' ')).toThrow(/reason/u)
  })

  it('lists due slots oldest first and lets exactly one run claim each', () => {
    const db = seededDatabase()
    seedSubmission(db)
    execute(
      db,
      buildQueueMediaPlans({
        kind: 'image',
        now: '2026-10-06T11:00:00.000Z',
        sortOrder: 0,
        sourceUrl: 'https://example.com/og.png',
        target: { submissionId }
      })
    )
    execute(
      db,
      buildQueueMediaPlans({
        kind: 'logo',
        now: NOW,
        sortOrder: 0,
        sourceUrl: 'https://assets.example/new.png',
        target: { listingId }
      })
    )
    execute(
      db,
      buildQueueMediaPlans({
        kind: 'image',
        now: '2026-10-06T13:00:00.000Z',
        sortOrder: 2,
        sourceUrl: 'https://assets.example/later.png',
        target: { listingId }
      })
    )
    const due = query(db, selectDueMediaPlan(NOW)) as Array<{ id: number; next_attempt_at: string }>
    // A submission's key is built from its id, a listing's from its slug; the listing row
    // carries what its slot holds now, which the cron's write compares and swaps on.
    expect(due).toMatchObject([
      {
        copy_from_key: null,
        current_media: null,
        kind: 'image',
        listing_id: null,
        slug: null,
        submission_id: submissionId
      },
      {
        copy_from_key: null,
        current_media: 'https://assets.example/old-logo.png',
        kind: 'logo',
        listing_id: listingId,
        slug,
        submission_id: null
      }
    ])
    const first = due[0]
    if (!first) throw new Error('No due slot.')
    const claim = buildClaimMediaPlans({
      id: first.id,
      now: NOW,
      readNextAttemptAt: first.next_attempt_at
    })
    execute(db, claim)
    expect(() => execute(db, claim)).toThrow(/malformed JSON/u)
    expect(query(db, selectDueMediaPlan(NOW))).toHaveLength(1)
    expect(() => selectDueMediaPlan(NOW, 0)).toThrow(/1 to 50/u)
  })
})

describe('submission media and approval', () => {
  it('records a hosted submission image and shows its slots to the reviewer', () => {
    const db = seededDatabase()
    seedSubmission(db)
    const plans = (media: HostedMedia) =>
      buildRecordSubmissionMediaPlans({
        kind: 'logo',
        media,
        now: NOW,
        sortOrder: 0,
        submissionId
      })
    execute(db, plans(pendingCopy('logo', 'b', 'https://example.com/logo.png')))
    execute(db, plans(pendingCopy('logo', 'c', 'https://example.com/logo.png')))
    expect(query(db, selectSubmissionMediaPlan(submissionId))).toEqual([
      {
        attempts: 2,
        kind: 'logo',
        last_error: null,
        media_key: pendingCopy('logo', 'c', '').key,
        next_attempt_at: null,
        sort_order: 0,
        source_url: 'https://example.com/logo.png',
        status: 'hosted'
      }
    ])
    expect(() =>
      execute(
        db,
        buildRecordSubmissionMediaPlans({
          kind: 'logo',
          media: hosted('logo', 'c', 'https://x.example/', { submissionId: 'sub_missing' }),
          now: NOW,
          sortOrder: 0,
          submissionId: 'sub_missing'
        })
      )
    ).toThrow(/malformed JSON/u)
    // A submission's image never lands under a listing's path, nor a listing's under a submission.
    expect(() => plans(hosted('logo', 'c'))).toThrow(/not a hosted logo key for submissions/u)
    expect(() =>
      buildHostListingMediaPlans({
        kind: 'logo',
        listingId,
        media: pendingCopy('logo', 'c', 'https://example.com/logo.png'),
        publication: publication('listing-media'),
        sortOrder: 0
      })
    ).toThrow(/not a hosted logo key for listings/u)
  })

  it("queues a copy of the submission's hosted logo and image into the listing's path", () => {
    const db = planDatabase()
    seedSubmission(db)
    const record = (kind: 'image' | 'logo', media: HostedMedia) =>
      execute(
        db,
        buildRecordSubmissionMediaPlans({ kind, media, now: NOW, sortOrder: 0, submissionId })
      )
    const logo = pendingCopy('logo', 'd', 'https://example.com/logo.png')
    const image = pendingCopy('image', 'e', 'https://example.com/og.png')
    record('logo', logo)
    record('image', image)
    approve(db, image.key)
    // Nothing renders from the submission's path: the page shows the tile until the copy lands.
    expect(
      count(db, "SELECT COUNT(*) AS count FROM listing_media WHERE listing_id='lst_approved'")
    ).toBe(0)
    expect(
      db
        .prepare(
          `SELECT kind,source_url,copy_from_key,status,next_attempt_at FROM media_ingestions
           WHERE listing_id='lst_approved' ORDER BY kind`
        )
        .all()
    ).toEqual([
      {
        copy_from_key: image.key,
        kind: 'image',
        next_attempt_at: NOW,
        source_url: image.sourceUrl,
        status: 'pending'
      },
      {
        copy_from_key: logo.key,
        kind: 'logo',
        next_attempt_at: NOW,
        source_url: logo.sourceUrl,
        status: 'pending'
      }
    ])
  })

  it('adopts only the featured image the reviewer saw (#96 review round 2, B1)', () => {
    const withImage = (key: string | null | undefined, hosted: HostedMedia | null) => {
      const db = planDatabase()
      seedSubmission(db)
      if (hosted) {
        execute(
          db,
          buildRecordSubmissionMediaPlans({
            kind: 'image',
            media: hosted,
            now: NOW,
            sortOrder: 0,
            submissionId
          })
        )
      }
      return { approveNow: () => approve(db, key), db }
    }
    const image = pendingCopy('image', 'e', 'https://example.com/og.png')
    const imageSlots = (db: DatabaseSync) =>
      count(
        db,
        "SELECT COUNT(*) AS count FROM media_ingestions WHERE listing_id='lst_approved' AND kind='image'"
      )
    // The image changed (or appeared) after the reviewer looked: the approval is refused.
    const stale = withImage(pendingCopy('image', 'f', '').key, image)
    expect(stale.approveNow).toThrow(/malformed JSON/u)
    expect(count(stale.db, 'SELECT COUNT(*) AS count FROM listings')).toBe(0)
    const appeared = withImage(null, image)
    expect(appeared.approveNow).toThrow(/malformed JSON/u)
    // The reviewer saw none, and there is none: approved without a featured image.
    const none = withImage(null, null)
    none.approveNow()
    expect(imageSlots(none.db)).toBe(0)
    // A caller that shows no images (the legacy approval workflow) never adopts one.
    const legacy = withImage(undefined, image)
    legacy.approveNow()
    expect(imageSlots(legacy.db)).toBe(0)
    // A waiting image the reviewer could not see is not adopted, and approval stays possible.
    const waiting = withImage(null, null)
    execute(
      waiting.db,
      buildQueueMediaPlans({
        kind: 'image',
        now: NOW,
        sortOrder: 0,
        sourceUrl: 'https://example.com/og.png',
        target: { submissionId }
      })
    )
    waiting.approveNow()
    expect(imageSlots(waiting.db)).toBe(0)
  })

  it('adopts only the reviewed logo, never a later fetch of its URL (#96 review round 3, S1)', () => {
    const setup = (logoUrl: string, hosted: HostedMedia | null) => {
      const db = planDatabase()
      seedSubmission(db, logoUrl)
      if (hosted) {
        execute(
          db,
          buildRecordSubmissionMediaPlans({
            kind: 'logo',
            media: hosted,
            now: NOW,
            sortOrder: 0,
            submissionId
          })
        )
      }
      return db
    }
    const listingSlots = (db: DatabaseSync) =>
      db
        .prepare(
          "SELECT copy_from_key,source_url FROM media_ingestions WHERE listing_id='lst_approved'"
        )
        .all()
    const logo = pendingCopy('logo', 'e', 'https://example.com/logo.png')
    // Not hosted at review (only an older source was): the reviewer saw the tile, and the
    // listing keeps the tile; the URL is never queued for a later fetch.
    const stale = setup(
      'https://example.com/new-logo.png',
      pendingCopy('logo', 'e', 'https://example.com/old-logo.png')
    )
    execute(
      stale,
      buildApproveSubmissionPlans({
        afterChecksum: 'after',
        affectedRoute: '/products/example.com/',
        beforeChecksum: 'before',
        expectedContentVersion: 1,
        expectedLogoKey: null,
        listingId: 'lst_approved',
        manifestId: `verified-submission-${submissionId}`,
        now: NOW,
        reviewer: 'reviewer',
        runId: `submission_publish_${submissionId}`,
        submissionId,
        version: 1
      })
    )
    expect(listingSlots(stale)).toEqual([])
    // The reviewed hosted logo is queued as a copy, never as its source.
    const reviewed = setup('https://example.com/logo.png', logo)
    const approveWith = (db: DatabaseSync, expectedLogoKey: string | null) =>
      execute(
        db,
        buildApproveSubmissionPlans({
          afterChecksum: 'after',
          affectedRoute: '/products/example.com/',
          beforeChecksum: 'before',
          expectedContentVersion: 1,
          expectedLogoKey,
          listingId: 'lst_approved',
          manifestId: `verified-submission-${submissionId}`,
          now: NOW,
          reviewer: 'reviewer',
          runId: `submission_publish_${submissionId}`,
          submissionId,
          version: 1
        })
      )
    approveWith(reviewed, logo.key)
    expect(listingSlots(reviewed)).toEqual([
      { copy_from_key: logo.key, source_url: 'https://example.com/logo.png' }
    ])
    // A logo hosted after the reviewer looked (or another one) refuses the approval.
    expect(() => approveWith(setup('https://example.com/logo.png', logo), null)).toThrow(
      /malformed JSON/u
    )
    expect(() =>
      approveWith(
        setup('https://example.com/logo.png', logo),
        pendingCopy('logo', 'f', 'https://example.com/logo.png').key
      )
    ).toThrow(/malformed JSON/u)
  })
})

describe('a cron claim against concurrent writers (#96 review B1)', () => {
  const source = 'https://assets.example/a.png'

  /** Queues logo A and claims it as the cron would: read, claim, remember the slot's value. */
  function claimLogo(db: DatabaseSync): MediaClaim {
    execute(
      db,
      buildQueueMediaPlans({
        kind: 'logo',
        now: NOW,
        sortOrder: 0,
        sourceUrl: source,
        target: { listingId }
      })
    )
    const [row] = query(db, selectDueMediaPlan(NOW, 10, listingId)) as Array<{
      current_media: string | null
      id: number
      next_attempt_at: string
    }>
    if (!row) throw new Error('No due slot.')
    execute(
      db,
      buildClaimMediaPlans({ id: row.id, now: NOW, readNextAttemptAt: row.next_attempt_at })
    )
    return {
      currentMedia: row.current_media,
      id: row.id,
      leaseUntil: mediaClaimLease(NOW),
      sourceUrl: source
    }
  }

  function cronHosts(db: DatabaseSync, claim: MediaClaim) {
    const state = publicationState(db)
    execute(
      db,
      buildHostListingMediaPlans({
        claim,
        kind: 'logo',
        listingId,
        media: hosted('logo', 'a', source),
        publication: publication('media-cron', state),
        sortOrder: 0
      })
    )
  }

  function logo(db: DatabaseSync) {
    return db
      .prepare("SELECT url,media_key FROM listing_media WHERE listing_id=? AND kind='logo'")
      .all(listingId)
  }

  it('hosts the claimed source while nothing else touched the slot', () => {
    const db = seededDatabase()
    const claim = claimLogo(db)
    cronHosts(db, claim)
    expect(logo(db)).toEqual([{ media_key: hosted('logo', 'a').key, url: source }])
    expect(slots(db)).toEqual([])
  })

  it('drops the cron result when an admin hosted another logo while it fetched', () => {
    const db = seededDatabase()
    const claim = claimLogo(db)
    // The admin's edit hosts logo B and clears the queue while the cron is fetching A.
    const b = hosted('logo', 'b', 'https://assets.example/b.png')
    execute(
      db,
      buildHostListingMediaPlans({
        kind: 'logo',
        listingId,
        media: b,
        publication: publication('listing-edit', publicationState(db)),
        sortOrder: 0
      })
    )
    const version = publicationState(db).version
    expect(() => cronHosts(db, claim)).toThrow(/malformed JSON/u)
    expect(() =>
      execute(
        db,
        buildRecordClaimedFailurePlans({
          attempts: 1,
          claim,
          code: 'http_503',
          now: NOW,
          retryable: true
        })
      )
    ).toThrow(/malformed JSON/u)
    // B stays, the queue is not re-created, and the catalog version did not move.
    expect(logo(db)).toEqual([{ media_key: b.key, url: b.sourceUrl }])
    expect(slots(db)).toEqual([])
    expect(publicationState(db).version).toBe(version)
  })

  it('drops the cron result when the slot was re-queued or changed under the claim', () => {
    // The same slot re-queued (a new source, or the same source with a fresh schedule).
    const requeued = seededDatabase()
    const claim = claimLogo(requeued)
    execute(
      requeued,
      buildQueueMediaPlans({
        kind: 'logo',
        now: NOW,
        sortOrder: 0,
        sourceUrl: source,
        target: { listingId }
      })
    )
    expect(() => cronHosts(requeued, claim)).toThrow(/malformed JSON/u)
    expect(slots(requeued)).toMatchObject([{ next_attempt_at: NOW, status: 'pending' }])
    // The claim still holds, but a publication replaced the slot's current value.
    const republished = seededDatabase()
    const held = claimLogo(republished)
    republished
      .prepare("UPDATE listing_media SET url=? WHERE listing_id=? AND kind='logo'")
      .run('https://assets.example/published.png', listingId)
    expect(() => cronHosts(republished, held)).toThrow(/malformed JSON/u)
    expect(logo(republished)).toEqual([
      { media_key: null, url: 'https://assets.example/published.png' }
    ])
  })

  it('records a failure only on the claimed row', () => {
    const db = seededDatabase()
    const claim = claimLogo(db)
    execute(
      db,
      buildRecordClaimedFailurePlans({
        attempts: 1,
        claim,
        code: 'http_503',
        now: NOW,
        retryable: true
      })
    )
    expect(slots(db)).toMatchObject([
      { attempts: 1, last_error: 'http_503', next_attempt_at: '2026-10-06T12:15:00.000Z' }
    ])
    // The claim is spent: a second write with it is refused.
    expect(() =>
      execute(
        db,
        buildRecordClaimedFailurePlans({ attempts: 2, claim, code: 'x', now: NOW, retryable: true })
      )
    ).toThrow(/malformed JSON/u)
  })

  it('records a claimed submission image only while the claim holds', () => {
    const db = seededDatabase()
    seedSubmission(db)
    execute(
      db,
      buildQueueMediaPlans({
        kind: 'image',
        now: NOW,
        sortOrder: 0,
        sourceUrl: 'https://example.com/og.png',
        target: { submissionId }
      })
    )
    const [row] = query(db, selectDueMediaPlan(NOW)) as Array<{
      id: number
      next_attempt_at: string
    }>
    if (!row) throw new Error('No due slot.')
    execute(
      db,
      buildClaimMediaPlans({ id: row.id, now: NOW, readNextAttemptAt: row.next_attempt_at })
    )
    const claim = {
      currentMedia: null,
      id: row.id,
      leaseUntil: mediaClaimLease(NOW),
      sourceUrl: 'https://example.com/og.png'
    }
    const record = () =>
      execute(
        db,
        buildRecordSubmissionMediaPlans({
          claim,
          kind: 'image',
          media: pendingCopy('image', 'f', 'https://example.com/og.png'),
          now: NOW,
          sortOrder: 0,
          submissionId
        })
      )
    record()
    expect(query(db, selectSubmissionMediaPlan(submissionId))).toMatchObject([
      { attempts: 1, media_key: pendingCopy('image', 'f', '').key, status: 'hosted' }
    ])
    expect(record).toThrow(/malformed JSON/u)
  })
})

describe('hosted media constraints', () => {
  it('requires a complete, prefixed, kind-matching key and a single queue target', () => {
    const db = seededDatabase()
    seedSubmission(db)
    const insertMedia = (columns: string, values: string) => () =>
      db.exec(
        `INSERT INTO listing_media (listing_id,kind,url,sort_order,${columns})
         VALUES ('${listingId}','logo','https://x.example/a.png',5,${values})`
      )
    const sha = `'${'f'.repeat(64)}'`
    const key = (path: string) => `'${path}'`
    expect(insertMedia('media_key', key(`best.serp.co/listings/${slug}/logo/ffff.png`))).toThrow(
      /CHECK constraint failed: listing_media_hosted_complete/u
    )
    expect(
      insertMedia(
        'media_key,sha256,content_type,bytes,width,height',
        `${key(`serp.co/listings/${slug}/logo/ffff.png`)},${sha},'image/png',10,1,1`
      )
    ).toThrow(/listing_media_hosted_complete/u)
    expect(
      insertMedia(
        'media_key,sha256,content_type,bytes,width,height',
        `${key(`best.serp.co/listings/${slug}/image/ffff.png`)},${sha},'image/png',10,1,1`
      )
    ).toThrow(/listing_media_hosted_complete/u)
    expect(
      insertMedia(
        'media_key,sha256,content_type,bytes,width,height',
        `${key(`best.serp.co/listings/${slug}/logo/ffff.svg`)},${sha},'image/svg+xml',10,1,1`
      )
    ).toThrow(/listing_media_hosted_complete/u)
    expect(
      insertMedia(
        'media_key,sha256,content_type,bytes,width,height',
        `${key(`best.serp.co/listings/${slug}/logo/ffff.png`)},${sha},'image/png',10,1,1`
      )
    ).not.toThrow()
    expect(() =>
      db.exec(
        `INSERT INTO media_ingestions (listing_id,submission_id,kind,source_url,next_attempt_at)
         VALUES ('${listingId}','${submissionId}','logo','https://x.example/a.png','${NOW}')`
      )
    ).toThrow(/media_ingestions_one_target/u)
    expect(() =>
      db.exec(
        `INSERT INTO media_ingestions (listing_id,kind,source_url)
         VALUES ('${listingId}','logo','https://x.example/a.png')`
      )
    ).toThrow(/media_ingestions_pending_scheduled/u)
    expect(() =>
      db.exec(
        `INSERT INTO media_ingestions (listing_id,kind,source_url,status)
         VALUES ('${listingId}','logo','https://x.example/a.png','failed')`
      )
    ).toThrow(/media_ingestions_failed_explained/u)
    // Only a listing slot copies, and only from a submission's key.
    const submissionKey = `best.serp.co/submissions/${submissionId}/logo/${'f'.repeat(16)}.png`
    expect(() =>
      db.exec(
        `INSERT INTO media_ingestions (submission_id,kind,source_url,next_attempt_at,copy_from_key)
         VALUES ('${submissionId}','logo','https://x.example/a.png','${NOW}','${submissionKey}')`
      )
    ).toThrow(/media_ingestions_copy_from_submission/u)
    expect(() =>
      db.exec(
        `INSERT INTO media_ingestions (listing_id,kind,source_url,next_attempt_at,copy_from_key)
         VALUES ('${listingId}','logo','https://x.example/a.png','${NOW}',
           'best.serp.co/listings/${slug}/logo/${'f'.repeat(16)}.png')`
      )
    ).toThrow(/media_ingestions_copy_from_submission/u)
    expect(() =>
      db.exec(
        `INSERT INTO media_ingestions (listing_id,kind,source_url,next_attempt_at,copy_from_key)
         VALUES ('${listingId}','logo','https://x.example/a.png','${NOW}','${submissionKey}')`
      )
    ).not.toThrow()
  })
})

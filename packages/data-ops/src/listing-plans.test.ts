import type { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import {
  buildGrantListingOwnerPlans,
  buildRepublishListingPlans,
  buildRevokeListingOwnerPlans,
  buildSetListingLinkRelPlans,
  buildUnpublishListingPlans,
  selectListingForPublicationPlan
} from './listing-plans'
import { prepareCatalogPublication } from './plan-support'
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

const listingId = 'lst_live'

function database(): DatabaseSync {
  const db = planDatabase()
  seedLiveListing(db, listingId)
  return db
}

function listing(db: DatabaseSync): Record<string, unknown> {
  return db.prepare('SELECT * FROM listings WHERE id=?').get(listingId) as Record<string, unknown>
}

/** A refused plan rolls back: no audit row, no version change, the listing untouched. */
function expectRefused(db: DatabaseSync, plans: Parameters<typeof execute>[1]): void {
  const before = listing(db)
  const owners = db.prepare('SELECT * FROM listing_owners ORDER BY id').all()
  const runs = count(db, 'SELECT COUNT(*) AS count FROM publication_runs')
  const state = publicationState(db)
  expect(() => execute(db, plans)).toThrow(/malformed JSON/u)
  expect(listing(db)).toEqual(before)
  expect(db.prepare('SELECT * FROM listing_owners ORDER BY id').all()).toEqual(owners)
  expect(count(db, 'SELECT COUNT(*) AS count FROM publication_runs')).toBe(runs)
  expect(publicationState(db)).toEqual(state)
}

function expectPublished(db: DatabaseSync, version: number): void {
  expect(publicationState(db).version).toBe(version)
  expect(
    count(db, "SELECT COUNT(*) AS count FROM publication_runs WHERE outcome='succeeded'")
  ).toBe(version - 1)
}

describe('listing publication transitions', () => {
  it('unpublishes a live listing (410 state) and republishes it at the same URL', () => {
    const db = database()
    db.exec(`
      INSERT INTO listing_submissions (id,slug,name,description,website,content,category_slug,
        logo_url,status,plan,listing_id)
      VALUES ('sub','lst_live.example','Live','d','https://lst_live.example/','c','tools','l',
        'approved','free','lst_live')`)
    execute(
      db,
      buildUnpublishListingPlans({
        listingId,
        publication: publication('listing-unpublish'),
        reason: 'badge_missing'
      })
    )
    expect(listing(db)).toMatchObject({
      is_active: 0,
      slug: 'lst_live.example',
      status: 'approved'
    })
    expect(
      db
        .prepare("SELECT detail FROM listing_submission_events WHERE event_type='unpublished'")
        .all()
    ).toEqual([{ detail: 'badge_missing' }])
    expectPublished(db, 2)
    expectRefused(
      db,
      buildUnpublishListingPlans({
        listingId,
        publication: publication('listing-unpublish-again', {
          checksum: publicationState(db).checksum,
          version: 2
        }),
        reason: 'admin'
      })
    )

    const republish = publication('listing-republish', {
      checksum: publicationState(db).checksum,
      version: 2
    })
    execute(db, buildRepublishListingPlans({ listingId, publication: republish }))
    expect(listing(db)).toMatchObject({ is_active: 1, status: 'approved' })
    expectPublished(db, 3)
    expectRefused(
      db,
      buildRepublishListingPlans({
        listingId,
        publication: publication('listing-republish-again', {
          checksum: publicationState(db).checksum,
          version: 3
        })
      })
    )
  })

  it("refuses to unpublish while the listing's own submission is in review", () => {
    for (const status of ['paid_pending_review', 'changes_requested'] as const) {
      const db = database()
      db.prepare(
        `INSERT INTO listing_submissions (id,slug,name,description,website,content,category_slug,
          logo_url,status,plan,paid_at,listing_id,published_checksum)
        VALUES ('sub','lst_live.example','Live','d','https://lst_live.example/','c','tools','l',
          ?,'paid',?,'lst_live','checksum-lst_live')`
      ).run(status, NOW)
      expectRefused(
        db,
        buildUnpublishListingPlans({
          listingId,
          publication: publication('listing-unpublish'),
          reason: 'admin'
        })
      )
      db.prepare("UPDATE listing_submissions SET status='approved' WHERE id='sub'").run()
      execute(
        db,
        buildUnpublishListingPlans({
          listingId,
          publication: publication('listing-unpublish'),
          reason: 'admin'
        })
      )
      expect(listing(db)).toMatchObject({ is_active: 0 })
    }
  })

  it('refuses a stale publication snapshot', () => {
    const db = database()
    db.prepare("UPDATE publication_state SET version=5, checksum='concurrent'").run()
    expectRefused(
      db,
      buildUnpublishListingPlans({
        listingId,
        publication: publication('listing-unpublish'),
        reason: 'admin'
      })
    )
  })

  it('republishes only with exactly one primary category (baseline triggers)', () => {
    const db = database()
    execute(
      db,
      buildUnpublishListingPlans({
        listingId,
        publication: publication('listing-unpublish'),
        reason: 'admin'
      })
    )
    db.prepare('DELETE FROM listing_categories WHERE listing_id=?').run(listingId)
    expect(() =>
      execute(
        db,
        buildRepublishListingPlans({
          listingId,
          publication: publication('listing-republish', {
            checksum: publicationState(db).checksum,
            version: 2
          })
        })
      )
    ).toThrow(/exactly one primary category/u)
    expect(listing(db)).toMatchObject({ is_active: 0 })
  })

  it('changes the outbound link setting and refuses a no-op', () => {
    const db = database()
    expect(listing(db)).toMatchObject({ link_rel: 'follow', source: 'admin' })
    execute(
      db,
      buildSetListingLinkRelPlans({
        linkRel: 'sponsored',
        listingId,
        publication: publication('listing-link-rel')
      })
    )
    expect(listing(db)).toMatchObject({ link_rel: 'sponsored' })
    expectPublished(db, 2)
    expectRefused(
      db,
      buildSetListingLinkRelPlans({
        linkRel: 'sponsored',
        listingId,
        publication: publication('listing-link-rel-again', {
          checksum: publicationState(db).checksum,
          version: 2
        })
      })
    )
    expect(() =>
      buildSetListingLinkRelPlans({
        linkRel: 'ugc' as 'follow',
        listingId,
        publication: publication('x')
      })
    ).toThrow(/follow, nofollow, or sponsored/u)
  })
})

describe('listing ownership transitions', () => {
  it('grants one current owner and refuses a second', () => {
    const db = database()
    execute(
      db,
      buildGrantListingOwnerPlans({
        listingId,
        publication: publication('listing-owner'),
        userId: 'user_owner',
        verifiedVia: 'badge_claim'
      })
    )
    expect(query(db, selectListingForPublicationPlan(listingId))).toMatchObject([
      { owner_user_id: 'user_owner', version: 2 }
    ])
    expectRefused(
      db,
      buildGrantListingOwnerPlans({
        listingId,
        publication: publication('listing-owner-again', {
          checksum: publicationState(db).checksum,
          version: 2
        }),
        userId: 'user_other',
        verifiedVia: 'paid_claim'
      })
    )
  })

  it('revokes the current owner, keeps the history, and allows a new owner', () => {
    const db = database()
    db.prepare(
      `INSERT INTO listing_owners (listing_id,user_id,verified_via,verified_at)
      VALUES (?, 'user_owner', 'badge_claim', ?)`
    ).run(listingId, NOW)
    const revoke = (version: number) =>
      buildRevokeListingOwnerPlans({
        listingId,
        publication: publication(`listing-owner-revoke-${version}`, {
          checksum: publicationState(db).checksum,
          version
        }),
        reason: 'badge_removed',
        userId: 'user_owner'
      })
    execute(db, revoke(1))
    expect(db.prepare('SELECT revoked_at,revoked_reason FROM listing_owners').all()).toEqual([
      { revoked_at: NOW, revoked_reason: 'badge_removed' }
    ])
    expect(listing(db)).toMatchObject({ is_active: 1 })
    expectRefused(db, revoke(2))
    execute(
      db,
      buildGrantListingOwnerPlans({
        listingId,
        publication: publication('listing-owner-new', {
          checksum: publicationState(db).checksum,
          version: 2
        }),
        userId: 'user_other',
        verifiedVia: 'paid_claim'
      })
    )
    expect(count(db, 'SELECT COUNT(*) AS count FROM listing_owners')).toBe(2)
  })

  it('derives publication ids and the chained checksum from the snapshot', async () => {
    const prepared = await prepareCatalogPublication({
      action: 'listing-unpublish',
      actor: 'admin@example.com',
      affectedRoutes: '/products/lst_live.example/',
      checksum: 'before',
      entityId: listingId,
      now: NOW,
      version: 1,
      workflow: 'app/admin'
    })
    expect(prepared).toMatchObject({
      manifestId: 'listing-unpublish-lst_live-v2',
      runId: 'listing-unpublish_lst_live_v2',
      version: 1
    })
    expect(prepared.afterChecksum).toBe(publication('listing-unpublish-lst_live').afterChecksum)
    const db = database()
    execute(db, buildUnpublishListingPlans({ listingId, publication: prepared, reason: 'admin' }))
    expect(publicationState(db)).toEqual({ checksum: prepared.afterChecksum, version: 2 })
  })
})

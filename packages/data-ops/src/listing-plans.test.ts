import type { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import {
  buildGrantListingOwnerPlans,
  buildRepublishListingPlans,
  buildRevokeListingOwnerPlans,
  buildSetListingLinkRelPlans,
  buildTransferListingOwnerPlans,
  buildUnpublishListingPlans,
  buildUpdateListingDetailsPlans,
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

describe('listing activity log and admin edits (#64)', () => {
  const at = (db: DatabaseSync, version: number, action: string) =>
    publication(action, { checksum: publicationState(db).checksum, version })

  function listingEvents(db: DatabaseSync): Array<Record<string, unknown>> {
    return db
      .prepare('SELECT event_type,detail,actor FROM listing_events WHERE listing_id=? ORDER BY id')
      .all(listingId) as Array<Record<string, unknown>>
  }

  it('records every listing change in listing_events with its actor and detail', () => {
    const db = database()
    execute(
      db,
      buildUnpublishListingPlans({
        listingId,
        note: '  Owner asked to take it down.  ',
        publication: publication('listing-unpublish'),
        reason: 'admin'
      })
    )
    execute(db, buildRepublishListingPlans({ listingId, publication: at(db, 2, 'republish') }))
    execute(
      db,
      buildSetListingLinkRelPlans({
        linkRel: 'nofollow',
        listingId,
        publication: at(db, 3, 'link')
      })
    )
    execute(
      db,
      buildGrantListingOwnerPlans({
        listingId,
        publication: at(db, 4, 'grant'),
        userId: 'user_owner',
        verifiedVia: 'badge_claim'
      })
    )
    execute(
      db,
      buildRevokeListingOwnerPlans({
        listingId,
        publication: at(db, 5, 'revoke'),
        reason: 'badge_removed',
        userId: 'user_owner'
      })
    )
    expect(listingEvents(db)).toEqual([
      {
        actor: 'reviewer',
        detail: JSON.stringify({ note: 'Owner asked to take it down.', reason: 'admin' }),
        event_type: 'unpublished'
      },
      { actor: 'reviewer', detail: null, event_type: 'republished' },
      {
        actor: 'reviewer',
        detail: JSON.stringify({ from: 'follow', to: 'nofollow' }),
        event_type: 'link_rel_changed'
      },
      {
        actor: 'reviewer',
        detail: JSON.stringify({ userId: 'user_owner', verifiedVia: 'badge_claim' }),
        event_type: 'owner_granted'
      },
      {
        actor: 'reviewer',
        detail: JSON.stringify({ reason: 'badge_removed', userId: 'user_owner' }),
        event_type: 'owner_revoked'
      }
    ])
  })

  it('keeps a listing whose submission was rejected down', () => {
    const db = database()
    db.exec(`
      INSERT INTO listing_submissions (id,slug,name,description,website,content,category_slug,
        logo_url,status,plan,listing_id,rejection_reason,rejection_category)
      VALUES ('sub','lst_live.example','Live','d','https://lst_live.example/','c','tools','l',
        'rejected','free','lst_live','Spam','other')`)
    db.prepare('UPDATE listings SET is_active=0 WHERE id=?').run(listingId)
    expectRefused(
      db,
      buildRepublishListingPlans({ listingId, publication: publication('listing-republish') })
    )
  })

  it('transfers ownership to another verified account and compares the current owner', () => {
    const db = database()
    // An ownerless listing: the admin assigns its first owner.
    execute(
      db,
      buildTransferListingOwnerPlans({
        fromUserId: null,
        listingId,
        publication: publication('transfer'),
        toUserId: 'user_owner'
      })
    )
    expect(query(db, selectListingForPublicationPlan(listingId))).toMatchObject([
      { owner_user_id: 'user_owner', version: 2 }
    ])
    // A stale view of the owner (the admin saw none) is refused.
    expectRefused(
      db,
      buildTransferListingOwnerPlans({
        fromUserId: null,
        listingId,
        publication: at(db, 2, 'transfer-stale'),
        toUserId: 'user_other'
      })
    )
    execute(
      db,
      buildTransferListingOwnerPlans({
        fromUserId: 'user_owner',
        listingId,
        publication: at(db, 2, 'transfer-again'),
        toUserId: 'user_other'
      })
    )
    expect(
      db.prepare('SELECT user_id,verified_via,revoked_reason FROM listing_owners ORDER BY id').all()
    ).toEqual([
      { revoked_reason: 'transferred', user_id: 'user_owner', verified_via: 'admin' },
      { revoked_reason: null, user_id: 'user_other', verified_via: 'admin' }
    ])
    expect(listingEvents(db).map(event => event.event_type)).toEqual([
      'owner_transferred',
      'owner_transferred'
    ])
    // The new owner needs a verified account.
    db.exec(`INSERT INTO users (id,name,email,email_verified)
      VALUES ('user_unverified','U','u@example.com',0)`)
    expectRefused(
      db,
      buildTransferListingOwnerPlans({
        fromUserId: 'user_other',
        listingId,
        publication: at(db, 3, 'transfer-unverified'),
        toUserId: 'user_unverified'
      })
    )
    expect(() =>
      buildTransferListingOwnerPlans({
        fromUserId: 'user_other',
        listingId,
        publication: at(db, 3, 'transfer-same'),
        toUserId: 'user_other'
      })
    ).toThrow(/already belongs/u)
  })

  const edit = {
    categorySlug: 'apps',
    description: 'A new short description.',
    logoUrl: 'https://assets.example/new-logo.png',
    name: 'Renamed',
    website: 'https://lst_live.example/home'
  }

  it("edits a live listing's details, keeps it live, and logs the fields", () => {
    const db = database()
    execute(
      db,
      buildUpdateListingDetailsPlans({
        details: edit,
        expectedChecksum: 'checksum-lst_live',
        fields: ['name', 'description', 'category', 'logo', 'website'],
        listingId,
        publication: publication('listing-edit')
      })
    )
    const prepared = publication('listing-edit')
    expect(listing(db)).toMatchObject({
      checksum: prepared.afterChecksum,
      description: edit.description,
      is_active: 1,
      name: 'Renamed',
      status: 'approved',
      website: edit.website
    })
    expect(
      db
        .prepare(
          `SELECT c.slug,lc.is_primary FROM listing_categories lc JOIN categories c
          ON c.id=lc.category_id WHERE lc.listing_id=? ORDER BY c.slug`
        )
        .all(listingId)
    ).toEqual([{ is_primary: 1, slug: 'apps' }])
    expect(
      db.prepare("SELECT url FROM listing_media WHERE listing_id=? AND kind='logo'").all(listingId)
    ).toEqual([{ url: edit.logoUrl }])
    // Other media stay.
    expect(
      count(
        db,
        "SELECT COUNT(*) AS count FROM listing_media WHERE kind='image' AND listing_id=?",
        listingId
      )
    ).toBe(1)
    expect(listingEvents(db)).toEqual([
      {
        actor: 'reviewer',
        detail: JSON.stringify({ fields: ['name', 'description', 'category', 'logo', 'website'] }),
        event_type: 'edited'
      }
    ])
    expectPublished(db, 2)
    // The checksum the admin saw is now stale.
    expectRefused(
      db,
      buildUpdateListingDetailsPlans({
        details: { ...edit, name: 'Again' },
        expectedChecksum: 'checksum-lst_live',
        fields: ['name'],
        listingId,
        publication: at(db, 2, 'listing-edit-stale')
      })
    )
  })

  it('edits an unpublished listing and leaves it unpublished', () => {
    const db = database()
    db.prepare('UPDATE listings SET is_active=0 WHERE id=?').run(listingId)
    execute(
      db,
      buildUpdateListingDetailsPlans({
        details: edit,
        expectedChecksum: 'checksum-lst_live',
        fields: ['name'],
        listingId,
        publication: publication('listing-edit')
      })
    )
    expect(listing(db)).toMatchObject({ is_active: 0, name: 'Renamed', status: 'approved' })
  })

  it('refuses an edit while a submission is queued, after a rejection, or to an unknown category', () => {
    for (const status of ['paid_pending_review', 'changes_requested', 'rejected'] as const) {
      const db = database()
      db.prepare(
        `INSERT INTO listing_submissions (id,slug,name,description,website,content,category_slug,
          logo_url,status,plan,paid_at,listing_id,published_checksum,rejection_reason,
          rejection_category)
        VALUES ('sub','lst_live.example','Live','d','https://lst_live.example/','c','tools','l',
          ?,'paid',?,'lst_live',?,?,?)`
      ).run(
        status,
        NOW,
        status === 'rejected' ? null : 'checksum-lst_live',
        status === 'rejected' ? 'Spam' : null,
        status === 'rejected' ? 'other' : null
      )
      expectRefused(
        db,
        buildUpdateListingDetailsPlans({
          details: edit,
          expectedChecksum: 'checksum-lst_live',
          fields: ['name'],
          listingId,
          publication: publication('listing-edit')
        })
      )
    }
    const db = database()
    expectRefused(
      db,
      buildUpdateListingDetailsPlans({
        details: { ...edit, categorySlug: 'missing' },
        expectedChecksum: 'checksum-lst_live',
        fields: ['category'],
        listingId,
        publication: publication('listing-edit')
      })
    )
    expect(() =>
      buildUpdateListingDetailsPlans({
        details: { ...edit, name: ' ' },
        expectedChecksum: 'checksum-lst_live',
        fields: ['name'],
        listingId,
        publication: publication('listing-edit')
      })
    ).toThrow(/name cannot be empty/u)
  })
})

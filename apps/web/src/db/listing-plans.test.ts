import type { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import {
  buildGrantListingOwnerPlans,
  buildRepublishListingPlans,
  buildRevokeListingOwnerPlans,
  buildSetListingLinkRelPlans,
  buildSetListingTagsPlans,
  buildTransferListingOwnerPlans,
  buildUnpublishListingPlans,
  buildUpdateListingDetailsPlans,
  type ListingDetailsField,
  type ListingLogoIngestion,
  listingWebsiteMatch,
  selectListingForPublicationPlan
} from './listing-plans'
import { prepareCatalogPublication } from './plan-support'
import {
  count,
  execute,
  listingTags,
  NOW,
  planDatabase,
  publication,
  publicationState,
  query,
  seedLiveListing,
  seedTags
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

  it('never republishes a listing filed under a retired category (#260)', () => {
    const db = database()
    execute(
      db,
      buildUnpublishListingPlans({
        listingId,
        publication: publication('listing-unpublish'),
        reason: 'admin'
      })
    )
    db.exec(`INSERT INTO categories (slug, name) VALUES ('adult', 'Adult');
      INSERT INTO listing_categories (listing_id, category_id, sort_order, is_primary)
        SELECT '${listingId}', id, 9, 0 FROM categories WHERE slug = 'adult';
      UPDATE categories SET is_active = 0 WHERE slug = 'adult';`)
    const republish = buildRepublishListingPlans({
      listingId,
      publication: publication('listing-republish', {
        checksum: publicationState(db).checksum,
        version: 2
      })
    })
    expectRefused(db, republish)
    // The plan's guard refuses first; D1 refuses too (0011_retired_categories), whatever the path.
    expect(() =>
      db.prepare('UPDATE listings SET is_active = 1 WHERE id = ?').run(listingId)
    ).toThrow(/must not be filed under a retired category/u)
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
    // The new logo is never stored as a hotlink: without an ingestion outcome it is queued.
    expect(
      db.prepare("SELECT url FROM listing_media WHERE listing_id=? AND kind='logo'").all(listingId)
    ).toEqual([])
    expect(
      db.prepare('SELECT listing_id,kind,source_url,status,attempts FROM media_ingestions').all()
    ).toEqual([
      {
        attempts: 0,
        kind: 'logo',
        listing_id: listingId,
        source_url: edit.logoUrl,
        status: 'pending'
      }
    ])
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

  it('refuses a website that collides, inside the batch, with the submission intake rules', () => {
    const move = (
      _db: DatabaseSync,
      website: string,
      fields: ListingDetailsField[] = ['website']
    ) =>
      buildUpdateListingDetailsPlans({
        details: { ...edit, website },
        expectedChecksum: 'checksum-lst_live',
        fields,
        listingId,
        publication: publication('listing-edit')
      })
    // Another listing's host (www. and the path don't matter) or URL.
    const listed = database()
    seedLiveListing(listed, 'lst_other', { slug: 'other.example' })
    expectRefused(listed, move(listed, 'https://www.other.example/pricing'))
    // Another listing's stored website in another spelling (scheme, www., trailing slash), or
    // with a query or fragment on either side.
    for (const [stored, website] of [
      ['https://www.new.example', 'http://new.example/'],
      ['https://www.new.example', 'https://new.example/?ref=abc'],
      ['https://new.example/?ref=abc', 'https://new.example/'],
      ['https://new.example/#top', 'https://www.new.example']
    ] as const) {
      const spelled = database()
      seedLiveListing(spelled, 'lst_beta', { slug: 'beta-tool' })
      spelled.prepare("UPDATE listings SET website=? WHERE id='lst_beta'").run(stored)
      expectRefused(spelled, move(spelled, website))
    }
    // A submission in flight for the host.
    const inFlight = database()
    inFlight
      .prepare(
        `INSERT INTO listing_submissions (id,slug,name,description,website,content,category_slug,
          logo_url,status,plan) VALUES ('sub','flight.example','Flight','d',
          'https://flight.example/','c','tools','https://flight.example/l.png','verified','free')`
      )
      .run()
    expectRefused(inFlight, move(inFlight, 'https://flight.example/'))
    // An active block on a parent domain.
    const blocked = database()
    blocked
      .prepare(
        `INSERT INTO listing_submission_url_blocks (url_key,covers_subdomains,reason,blocked_by,
          blocked_at) VALUES ('casino.example',1,'Gambling','admin',?)`
      )
      .run(NOW)
    expectRefused(blocked, move(blocked, 'https://app.casino.example/'))
    // The intake's URL rule, for the website and the logo.
    expect(() => move(database(), 'http://127.0.0.1/')).toThrow(/public HTTP\(S\)/u)
    expect(() =>
      buildUpdateListingDetailsPlans({
        details: { ...edit, logoUrl: 'http://localhost/logo.png' },
        expectedChecksum: 'checksum-lst_live',
        fields: ['logo'],
        listingId,
        publication: publication('listing-edit')
      })
    ).toThrow(/public HTTP\(S\)/u)
    // An edit that keeps the website isn't checked against legacy duplicates.
    const legacy = database()
    seedLiveListing(legacy, 'lst_twin', { slug: 'twin.example' })
    legacy
      .prepare("UPDATE listings SET website='https://lst_live.example/home' WHERE id='lst_twin'")
      .run()
    execute(legacy, move(legacy, 'https://lst_live.example/home', ['name']))
    expect(listing(legacy)).toMatchObject({ name: 'Renamed' })
  })

  it('matches another listing by host slug, or by stored website with its query or fragment ignored', () => {
    const db = database()
    seedLiveListing(db, 'lst_beta', { slug: 'beta-tool' })
    const listed = (website: string, exceptListingId = listingId) => {
      const match = listingWebsiteMatch({ exceptListingId, website })
      return (
        db.prepare(`SELECT ${match.sql} AS listed`).get(...(match.params as string[])) as {
          listed: number
        }
      ).listed
    }
    const matches = (stored: string, website: string) => {
      db.prepare("UPDATE listings SET website=? WHERE id='lst_beta'").run(stored)
      return listed(website)
    }
    // Both directions: a query or fragment on the stored or the new URL doesn't matter.
    for (const [stored, website] of [
      ['https://x.example/', 'https://x.example/?ref=abc'],
      ['https://x.example/', 'https://x.example/#top'],
      ['https://x.example/?ref=abc', 'https://x.example/'],
      ['https://x.example/#top', 'https://x.example/'],
      ['https://www.x.example?ref=abc', 'http://x.example/#top'],
      ['https://x.example/tool?ref=abc', 'https://www.x.example/tool/'],
      ['https://x.example/?ref=abc', 'https://x.example/?ref=other']
    ] as const) {
      expect(matches(stored, website), `${stored} ${website}`).toBe(1)
    }
    // Another page on the host, or a path that only starts the same, is another website.
    for (const [stored, website] of [
      ['https://x.example/tool?ref=abc', 'https://x.example/'],
      ['https://x.example/tool-pro?ref=abc', 'https://x.example/tool'],
      ['https://x.example/?ref=abc', 'https://x.example/tool']
    ] as const) {
      expect(matches(stored, website), `${stored} ${website}`).toBe(0)
    }
    // A listing never matches itself; another listing's slug that is the host does.
    expect(listed('https://lst_live.example/?ref=abc')).toBe(0)
    expect(listed('https://lst_live.example/?ref=abc', 'lst_beta')).toBe(1)
  })

  it('validates and writes the website and logo only when the edit changes them', () => {
    const logos = (db: DatabaseSync) =>
      db.prepare("SELECT url FROM listing_media WHERE listing_id=? AND kind='logo'").all(listingId)
    const rename = (_db: DatabaseSync, details: Partial<typeof edit>) =>
      buildUpdateListingDetailsPlans({
        details: { ...edit, ...details },
        expectedChecksum: 'checksum-lst_live',
        fields: ['name'],
        listingId,
        publication: publication('listing-edit')
      })
    // Imported listings (#64 review): no logo (the fallback tile), or a site-relative one.
    const noLogo = database()
    noLogo.prepare("DELETE FROM listing_media WHERE listing_id=? AND kind='logo'").run(listingId)
    execute(noLogo, rename(noLogo, { logoUrl: '' }))
    expect(listing(noLogo)).toMatchObject({ name: 'Renamed', website: 'https://lst_live.example/' })
    expect(logos(noLogo)).toEqual([])
    const relative = database()
    relative
      .prepare("UPDATE listing_media SET url=? WHERE listing_id=? AND kind='logo'")
      .run('/listing-logos/lst_live.example/logo.png', listingId)
    execute(relative, rename(relative, { logoUrl: '/listing-logos/lst_live.example/logo.png' }))
    expect(listing(relative)).toMatchObject({ name: 'Renamed' })
    expect(logos(relative)).toEqual([{ url: '/listing-logos/lst_live.example/logo.png' }])
    // An unchanged website is neither checked nor written, even when the edit carries another.
    const keeps = database()
    execute(keeps, rename(keeps, { website: 'http://127.0.0.1/' }))
    expect(listing(keeps)).toMatchObject({ website: 'https://lst_live.example/' })

    // A changed logo is checked; an emptied one removes the logo row.
    const changeLogo = (_db: DatabaseSync, logoUrl: string) =>
      buildUpdateListingDetailsPlans({
        details: { ...edit, logoUrl },
        expectedChecksum: 'checksum-lst_live',
        fields: ['logo'],
        listingId,
        publication: publication('listing-edit')
      })
    expect(() => changeLogo(database(), '/listing-logos/other.png')).toThrow(/public HTTP\(S\)/u)
    const cleared = database()
    execute(cleared, changeLogo(cleared, ' '))
    expect(logos(cleared)).toEqual([])
    expect(
      count(
        cleared,
        "SELECT COUNT(*) AS count FROM listing_media WHERE kind='image' AND listing_id=?",
        listingId
      )
    ).toBe(1)
    // A hosted copy of the new source becomes the logo row; a failed first attempt is queued with
    // its reason, or fails for good, behind the fallback tile (#95).
    const hostedLogo = {
      bytes: 100,
      contentType: 'image/png',
      height: 256,
      key: `best.serp.co/listings/lst_live.example/logo/${'1'.repeat(16)}.png`,
      sha256: '1'.repeat(64),
      sourceUrl: edit.logoUrl,
      width: 256
    }
    const withIngestion = (_db: DatabaseSync, logoIngestion: ListingLogoIngestion) =>
      buildUpdateListingDetailsPlans({
        details: edit,
        expectedChecksum: 'checksum-lst_live',
        fields: ['logo'],
        listingId,
        logoIngestion,
        publication: publication('listing-edit')
      })
    const hosted = database()
    execute(hosted, withIngestion(hosted, { hosted: hostedLogo }))
    expect(
      hosted
        .prepare("SELECT url,media_key FROM listing_media WHERE listing_id=? AND kind='logo'")
        .all(listingId)
    ).toEqual([{ media_key: hostedLogo.key, url: edit.logoUrl }])
    expect(count(hosted, 'SELECT COUNT(*) AS count FROM media_ingestions')).toBe(0)
    expect(() =>
      withIngestion(database(), { hosted: { ...hostedLogo, sourceUrl: 'https://other.example/' } })
    ).toThrow(/edited source/u)
    // A source that can never be hosted is not saved: the edit fails and nothing changes (#96 S4).
    expect(() => withIngestion(database(), { failure: { code: 'svg', retryable: false } })).toThrow(
      /cannot be hosted \(svg\) is not saved/u
    )
    // A retryable failure queues the new source with its reason; an unhosted current logo row
    // gives way to the fallback tile until the copy lands.
    const failed = database()
    execute(failed, withIngestion(failed, { failure: { code: 'http_503', retryable: true } }))
    expect(logos(failed)).toEqual([])
    expect(
      failed.prepare('SELECT status,attempts,last_error,source_url FROM media_ingestions').all()
    ).toEqual([
      { attempts: 1, last_error: 'http_503', source_url: edit.logoUrl, status: 'pending' }
    ])
    // A hosted working logo is kept until the queued copy replaces it (#96 S4).
    const working = database()
    execute(working, withIngestion(working, { hosted: hostedLogo }))
    const next = 'https://lst_live.example/next-logo.png'
    const state = publicationState(working)
    const { checksum } = working
      .prepare('SELECT checksum FROM listings WHERE id=?')
      .get(listingId) as { checksum: string }
    execute(
      working,
      buildUpdateListingDetailsPlans({
        details: { ...edit, logoUrl: next },
        expectedChecksum: checksum,
        fields: ['logo'],
        listingId,
        logoIngestion: { failure: { code: 'http_503', retryable: true } },
        publication: publication('listing-edit-again', state)
      })
    )
    expect(
      working
        .prepare("SELECT url,media_key FROM listing_media WHERE listing_id=? AND kind='logo'")
        .all(listingId)
    ).toEqual([{ media_key: hostedLogo.key, url: edit.logoUrl }])
    expect(working.prepare('SELECT status,source_url FROM media_ingestions').all()).toEqual([
      { source_url: next, status: 'pending' }
    ])
    // Saving the hosted logo's source again cancels the queued replacement (#96 r2 S2).
    const cancel = (db: DatabaseSync, logoUrl: string) => {
      const live = publicationState(db)
      const { checksum: current } = db
        .prepare('SELECT checksum FROM listings WHERE id=?')
        .get(listingId) as { checksum: string }
      return buildUpdateListingDetailsPlans({
        details: { ...edit, logoUrl },
        expectedChecksum: current,
        fields: ['logo'],
        listingId,
        logoCancelQueued: true,
        publication: publication('listing-edit-cancel', live)
      })
    }
    // Only the hosted logo's own source cancels; anything else is refused.
    expect(() => execute(working, cancel(working, next))).toThrow(/malformed JSON/u)
    execute(working, cancel(working, edit.logoUrl))
    expect(count(working, 'SELECT COUNT(*) AS count FROM media_ingestions')).toBe(0)
    expect(
      working
        .prepare("SELECT url,media_key FROM listing_media WHERE listing_id=? AND kind='logo'")
        .all(listingId)
    ).toEqual([{ media_key: hostedLogo.key, url: edit.logoUrl }])
    // A changed website must be a public URL.
    expect(() =>
      buildUpdateListingDetailsPlans({
        details: { ...edit, website: '' },
        expectedChecksum: 'checksum-lst_live',
        fields: ['website'],
        listingId,
        publication: publication('listing-edit')
      })
    ).toThrow(/public HTTP\(S\)/u)
  })
})

describe("an admin's tag edit (#341, design 4.3)", () => {
  function tagged(): DatabaseSync {
    const db = database()
    seedTags(db)
    return db
  }

  function setTags(
    tags: readonly string[],
    expectedTags: readonly string[],
    version = 1,
    db?: DatabaseSync
  ) {
    return buildSetListingTagsPlans({
      expectedTags,
      listingId,
      publication: publication('listing-tags', {
        checksum: db ? publicationState(db).checksum : undefined,
        version
      }),
      tags
    })
  }

  it('replaces the tags in order, logs them, and publishes without touching the checksum', () => {
    const db = tagged()
    const before = listing(db)
    execute(db, setTags(['whiteboards', 'note-taking'], []))
    expect(listingTags(db, listingId)).toEqual(['whiteboards', 'note-taking'])
    expect(listing(db)).toMatchObject({ checksum: before.checksum, updated_at: NOW })
    expectPublished(db, 2)
    expect(
      db.prepare("SELECT detail,actor FROM listing_events WHERE event_type='edited'").all()
    ).toEqual([
      {
        actor: 'reviewer',
        detail: JSON.stringify({
          fields: ['tags'],
          from: [],
          to: ['whiteboards', 'note-taking']
        })
      }
    ])
    // The next edit compares against the tags as they are now, in that order.
    expectRefused(db, setTags(['note-taking'], ['note-taking', 'whiteboards'], 2, db))
    execute(db, setTags(['note-taking'], ['whiteboards', 'note-taking'], 2, db))
    expect(listingTags(db, listingId)).toEqual(['note-taking'])
    execute(db, setTags([], ['note-taking'], 3, db))
    expect(listingTags(db, listingId)).toEqual([])
    expectPublished(db, 4)
  })

  it('refuses a retired or unknown tag, and stale tags, leaving the tags as they were', () => {
    const db = tagged()
    execute(db, setTags(['whiteboards'], []))
    const expected = ['whiteboards']
    for (const tags of [['retired-tag'], ['no-such-tag'], ['note-taking', 'retired-tag']]) {
      expectRefused(db, setTags(tags, expected, 2, db))
      expect(listingTags(db, listingId)).toEqual(expected)
    }
    expectRefused(db, setTags(['note-taking'], [], 2, db))
    expect(() => setTags(['note-taking', 'note-taking'], expected)).toThrow(/distinct/u)
  })

  it('keeps a retired tag in the comparison, and the edit can drop it', () => {
    const db = tagged()
    db.exec(`INSERT INTO listing_tags (listing_id,tag_id,sort_order)
      SELECT '${listingId}',id,0 FROM tags WHERE slug='note-taking'`)
    db.exec("UPDATE tags SET is_active=0 WHERE slug='note-taking'")
    expectRefused(db, setTags(['whiteboards'], []))
    execute(db, setTags(['whiteboards'], ['note-taking']))
    expect(listingTags(db, listingId)).toEqual(['whiteboards'])
  })

  it("is allowed while the listing's submission is in review, unlike a details edit", () => {
    const db = tagged()
    db.prepare(
      `INSERT INTO listing_submissions (id,slug,name,description,website,content,category_slug,
        logo_url,status,plan,paid_at,listing_id,published_checksum)
      VALUES ('sub','lst_live.example','Live','d','https://lst_live.example/','c','tools','l',
        'paid_pending_review','paid',?,'lst_live','checksum-lst_live')`
    ).run(NOW)
    execute(db, setTags(['note-taking'], []))
    expect(listingTags(db, listingId)).toEqual(['note-taking'])
    // The checksum stays, so the paid submission's approval still matches what it published.
    expect(listing(db).checksum).toBe('checksum-lst_live')
  })

  it('refuses a listing whose submission was rejected, or one that is not approved', () => {
    const db = tagged()
    db.prepare(
      `INSERT INTO listing_submissions (id,slug,name,description,website,content,category_slug,
        logo_url,status,plan,listing_id,rejection_reason,rejection_category)
      VALUES ('sub','lst_live.example','Live','d','https://lst_live.example/','c','tools','l',
        'rejected','free','lst_live','Spam','other')`
    ).run()
    expectRefused(db, setTags(['note-taking'], []))
    db.exec("DELETE FROM listing_submissions WHERE id='sub'")
    db.exec(`UPDATE listings SET status='draft' WHERE id='${listingId}'`)
    expectRefused(db, setTags(['note-taking'], []))
  })
})

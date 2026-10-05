import type { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import type { StagedListingContent, StatementPlan } from './plan-support'
import {
  categoryId,
  count,
  execute,
  NOW,
  planDatabase,
  publication,
  publicationState,
  query,
  seedLiveListing
} from './plan-test-support'
import {
  buildApproveRevisionPlans,
  buildCreateRevisionPlans,
  buildRejectRevisionPlans,
  buildReplaceRevisionContentPlans,
  buildRequestRevisionChangesPlans,
  buildResubmitRevisionPlans,
  buildWithdrawRevisionPlans,
  revisionTransitions,
  selectRevisionForDecisionPlan
} from './revision-plans'
import { type RevisionStatus, revisionStatuses } from './schema'

const listingId = 'lst_owned'
const revisionId = '22222222-2222-4222-8222-222222222222'

const content: StagedListingContent = {
  categorySlug: 'apps',
  content: 'Revised content',
  description: 'Revised description',
  faqs: [
    { answer: 'Yes.', question: 'Is there a free tier?' },
    { answer: 'Email.', question: 'How do I get support?' }
  ],
  logoUrl: 'https://assets.example/new-logo.png',
  name: 'Owned (revised)',
  resourceLinks: [{ label: 'Pricing', url: 'https://owned.example/pricing' }],
  videoUrl: 'https://assets.example/demo.mp4'
}

/** A live listing in Tools (primary) and Apps, owned by `user_owner`. */
function database(): DatabaseSync {
  const db = planDatabase()
  seedLiveListing(db, listingId, { categories: ['tools'], checksum: 'base' })
  db.prepare(
    `INSERT INTO listing_owners (listing_id,user_id,verified_via,verified_at)
    VALUES (?, 'user_owner', 'paid_claim', ?)`
  ).run(listingId, NOW)
  return db
}

function revision(db: DatabaseSync): Record<string, unknown> | undefined {
  return db.prepare('SELECT * FROM listing_revisions WHERE id=?').get(revisionId) as
    | Record<string, unknown>
    | undefined
}

function seedRevision(db: DatabaseSync, status: RevisionStatus): void {
  execute(
    db,
    buildCreateRevisionPlans({
      authorUserId: 'user_owner',
      content,
      listingId,
      now: NOW,
      revisionId
    })
  )
  db.prepare(
    `UPDATE listing_revisions SET status=?, rejection_reason=CASE WHEN ?='rejected' THEN 'x' END
    WHERE id=?`
  ).run(status, status, revisionId)
}

function revisionEvents(db: DatabaseSync, eventType: string): number {
  return count(
    db,
    'SELECT COUNT(*) AS count FROM listing_revision_events WHERE event_type=?',
    eventType
  )
}

function expectTransition(spec: {
  after: (db: DatabaseSync, from: RevisionStatus) => void
  event: string
  plans: () => StatementPlan[]
  succeeds: readonly RevisionStatus[]
}): void {
  for (const status of revisionStatuses) {
    const db = database()
    seedRevision(db, status)
    const before = revision(db)
    const listingBefore = db.prepare('SELECT * FROM listings').all()
    const eventsBefore = revisionEvents(db, spec.event)
    if (spec.succeeds.includes(status)) {
      execute(db, spec.plans())
      expect(revisionEvents(db, spec.event), `${status}: ${spec.event}`).toBe(eventsBefore + 1)
      spec.after(db, status)
    } else {
      expect(() => execute(db, spec.plans()), `${status} must be refused`).toThrow(
        /malformed JSON/u
      )
      expect(revision(db), `${status} unchanged`).toEqual(before)
      expect(revisionEvents(db, spec.event)).toBe(eventsBefore)
      expect(db.prepare('SELECT * FROM listings').all()).toEqual(listingBefore)
      expect(publicationState(db).version).toBe(1)
    }
    db.close()
  }
}

describe('revision creation', () => {
  it("stages the current owner's edit of a live listing against its checksum", () => {
    const db = database()
    seedRevision(db, 'pending_review')
    expect(revision(db)).toMatchObject({
      author_user_id: 'user_owner',
      base_checksum: 'base',
      category_slug: 'apps',
      status: 'pending_review'
    })
    expect(count(db, 'SELECT COUNT(*) AS count FROM listing_revision_faqs')).toBe(2)
    expect(revisionEvents(db, 'created')).toBe(1)
    // Nothing reaches the catalog before approval.
    expect(db.prepare('SELECT name FROM listings').get()).toEqual({ name: `Live ${listingId}` })
    expect(query(db, selectRevisionForDecisionPlan(revisionId))).toMatchObject([
      { base_checksum: 'base', listing_checksum: 'base', listing_live: 1, version: 1 }
    ])
  })

  it('refuses a non-owner, an unpublished listing, and a second open revision', () => {
    const create = (author: string, id = revisionId) =>
      buildCreateRevisionPlans({
        authorUserId: author,
        content,
        listingId,
        now: NOW,
        revisionId: id
      })

    const stranger = database()
    expect(() => execute(stranger, create('user_other'))).toThrow(/malformed JSON/u)

    const unpublished = database()
    unpublished.prepare('UPDATE listings SET is_active=0').run()
    expect(() => execute(unpublished, create('user_owner'))).toThrow(/malformed JSON/u)

    const open = database()
    execute(open, create('user_owner'))
    expect(() => execute(open, create('user_owner', crypto.randomUUID()))).toThrow(
      /UNIQUE constraint failed: listing_revisions.listing_id/u
    )
    expect(count(open, 'SELECT COUNT(*) AS count FROM listing_revisions')).toBe(1)
  })
})

describe('revision status transitions (compare-and-swap with changes() assertions)', () => {
  it('requests changes on a pending revision', () => {
    expectTransition({
      after: db =>
        expect(revision(db)).toMatchObject({
          reviewer_note: 'Shorter description, please.',
          status: 'changes_requested'
        }),
      event: 'changes_requested',
      plans: () =>
        buildRequestRevisionChangesPlans({
          note: 'Shorter description, please.',
          now: NOW,
          reviewer: 'reviewer',
          revisionId
        }),
      succeeds: revisionTransitions.requestChanges.from
    })
  })

  it('resubmits, withdraws, and edits for the author only', () => {
    expectTransition({
      after: db => expect(revision(db)?.status).toBe('pending_review'),
      event: 'resubmitted',
      plans: () => buildResubmitRevisionPlans({ authorUserId: 'user_owner', now: NOW, revisionId }),
      succeeds: revisionTransitions.resubmit.from
    })
    expectTransition({
      after: db => expect(revision(db)?.status).toBe('withdrawn'),
      event: 'withdrawn',
      plans: () => buildWithdrawRevisionPlans({ authorUserId: 'user_owner', now: NOW, revisionId }),
      succeeds: revisionTransitions.withdraw.from
    })
    expectTransition({
      after: (db, from) =>
        expect(revision(db)).toMatchObject({ name: 'Edited again', status: from }),
      event: 'edited',
      plans: () =>
        buildReplaceRevisionContentPlans({
          authorUserId: 'user_owner',
          content: { ...content, name: 'Edited again' },
          now: NOW,
          revisionId
        }),
      succeeds: revisionTransitions.edit.from
    })
    const db = database()
    seedRevision(db, 'changes_requested')
    for (const plans of [
      buildResubmitRevisionPlans({ authorUserId: 'user_other', now: NOW, revisionId }),
      buildWithdrawRevisionPlans({ authorUserId: 'user_other', now: NOW, revisionId })
    ]) {
      expect(() => execute(db, plans)).toThrow(/malformed JSON/u)
    }
    expect(revision(db)?.status).toBe('changes_requested')
  })

  it('rejects an open revision with a reason and leaves the listing as it was', () => {
    expectTransition({
      after: db => {
        expect(revision(db)).toMatchObject({
          rejection_reason: 'Not accurate.',
          status: 'rejected'
        })
        expect(db.prepare('SELECT name,checksum FROM listings').get()).toEqual({
          checksum: 'base',
          name: `Live ${listingId}`
        })
      },
      event: 'rejected',
      plans: () =>
        buildRejectRevisionPlans({ now: NOW, reason: 'Not accurate.', reviewer: 'r', revisionId }),
      succeeds: revisionTransitions.reject.from
    })
  })

  it('approves a pending revision by applying it to the live listing atomically', () => {
    expectTransition({
      after: db => {
        const pub = publication('revision-approval')
        expect(revision(db)).toMatchObject({ reviewed_by: 'reviewer', status: 'approved' })
        expect(db.prepare('SELECT * FROM listings').get()).toMatchObject({
          checksum: pub.afterChecksum,
          content: 'Revised content',
          description: 'Revised description',
          is_active: 1,
          name: 'Owned (revised)',
          published_at: '2026-05-16',
          slug: `${listingId}.example`,
          status: 'approved',
          website: `https://${listingId}.example/`
        })
        expect(
          db
            .prepare(
              'SELECT category_id,is_primary FROM listing_categories ORDER BY is_primary DESC'
            )
            .all()
        ).toEqual([{ category_id: categoryId(db, 'apps'), is_primary: 1 }])
        expect(
          db.prepare('SELECT kind,url FROM listing_media ORDER BY kind,sort_order').all()
        ).toEqual([
          { kind: 'image', url: 'https://assets.example/image.png' },
          { kind: 'logo', url: 'https://assets.example/new-logo.png' },
          { kind: 'video', url: 'https://assets.example/demo.mp4' }
        ])
        expect(db.prepare('SELECT label FROM listing_resource_links').all()).toEqual([
          { label: 'Pricing' }
        ])
        expect(count(db, 'SELECT COUNT(*) AS count FROM listing_faqs')).toBe(2)
        expect(publicationState(db)).toEqual({ checksum: pub.afterChecksum, version: 2 })
      },
      event: 'approved',
      plans: () =>
        buildApproveRevisionPlans({
          listingId,
          now: NOW,
          publication: publication('revision-approval'),
          reviewer: 'reviewer',
          revisionId
        }),
      succeeds: revisionTransitions.approve.from
    })
  })

  it('replaces the primary category and keeps the secondary ones', () => {
    const db = planDatabase()
    db.exec("INSERT INTO categories (slug, name, sort_order) VALUES ('games', 'Games', 2)")
    seedLiveListing(db, listingId, { categories: ['tools', 'apps'], checksum: 'base' })
    db.prepare(
      `INSERT INTO listing_owners (listing_id,user_id,verified_via,verified_at)
      VALUES (?, 'user_owner', 'badge_claim', ?)`
    ).run(listingId, NOW)
    execute(
      db,
      buildCreateRevisionPlans({
        authorUserId: 'user_owner',
        content: { ...content, categorySlug: 'games' },
        listingId,
        now: NOW,
        revisionId
      })
    )
    execute(
      db,
      buildApproveRevisionPlans({
        listingId,
        now: NOW,
        publication: publication('revision-approval'),
        reviewer: 'reviewer',
        revisionId
      })
    )
    expect(
      db
        .prepare(
          `SELECT c.slug,lc.is_primary FROM listing_categories lc
          JOIN categories c ON c.id=lc.category_id ORDER BY lc.is_primary DESC,c.slug`
        )
        .all()
    ).toEqual([
      { is_primary: 1, slug: 'games' },
      { is_primary: 0, slug: 'apps' }
    ])
  })

  it('refuses a revision whose category is not active, leaving the listing live', () => {
    const db = database()
    execute(
      db,
      buildCreateRevisionPlans({
        authorUserId: 'user_owner',
        content: { ...content, categorySlug: 'retired' },
        listingId,
        now: NOW,
        revisionId
      })
    )
    expect(() =>
      execute(
        db,
        buildApproveRevisionPlans({
          listingId,
          now: NOW,
          publication: publication('revision-approval'),
          reviewer: 'reviewer',
          revisionId
        })
      )
    ).toThrow(/malformed JSON/u)
    expect(db.prepare('SELECT status,is_active,name FROM listings').get()).toEqual({
      is_active: 1,
      name: `Live ${listingId}`,
      status: 'approved'
    })
    expect(count(db, 'SELECT COUNT(*) AS count FROM listing_categories')).toBe(1)
  })

  it('refuses approval when the listing changed, went offline, or changed owner', () => {
    const approve = () =>
      buildApproveRevisionPlans({
        listingId,
        now: NOW,
        publication: publication('revision-approval'),
        reviewer: 'reviewer',
        revisionId
      })
    for (const change of [
      "UPDATE listings SET checksum='edited-by-admin'",
      'UPDATE listings SET is_active=0',
      `UPDATE listing_owners SET revoked_at='${NOW}', revoked_reason='badge_removed'`
    ]) {
      const db = database()
      seedRevision(db, 'pending_review')
      db.exec(change)
      expect(() => execute(db, approve()), change).toThrow(/malformed JSON/u)
      expect(revision(db)?.status).toBe('pending_review')
      expect(publicationState(db).version).toBe(1)
      expect(count(db, 'SELECT COUNT(*) AS count FROM publication_runs')).toBe(0)
    }
  })
})

import type { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { buildQueueMediaPlans, buildRecordPendingMediaPlans } from './media-plans'
import type { StagedListingContent, StatementPlan } from './plan-support'
import {
  categoryId,
  count,
  execute,
  listingTagOrder,
  NOW,
  planDatabase,
  primaryCategory,
  publication,
  publicationState,
  query,
  seedLiveListing,
  seedTags
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
import {
  buildApproveLiveSubmissionPlans,
  buildRecordSubmissionPaymentPlans
} from './submission-plans'

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

    // The author's edit compares and swaps on the version their form loaded (#102 round 1).
    const versioned = database()
    seedRevision(versioned, 'pending_review')
    const edit = (expectedContentVersion: number, name: string) =>
      buildReplaceRevisionContentPlans({
        authorUserId: 'user_owner',
        content: { ...content, name },
        expectedContentVersion,
        now: NOW,
        revisionId
      })
    execute(versioned, edit(1, 'First tab'))
    expect(() => execute(versioned, edit(1, 'Stale tab'))).toThrow(/malformed JSON/u)
    expect(revision(versioned)).toMatchObject({ content_version: 2, name: 'First tab' })
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
          // The new logo was not hosted at review: never hotlinked, never fetched later
          // unreviewed (#96 round 3 S1), and the listing keeps its current logo (round 4 S1).
          { kind: 'logo', url: 'https://assets.example/old-logo.png' },
          { kind: 'video', url: 'https://assets.example/demo.mp4' }
        ])
        expect(count(db, 'SELECT COUNT(*) AS count FROM media_ingestions')).toBe(0)
        expect(db.prepare('SELECT label FROM listing_resource_links').all()).toEqual([
          { label: 'Pricing' }
        ])
        expect(count(db, 'SELECT COUNT(*) AS count FROM listing_faqs')).toBe(2)
        expect(publicationState(db)).toEqual({ checksum: pub.afterChecksum, version: 2 })
      },
      event: 'approved',
      plans: () =>
        buildApproveRevisionPlans({
          expectedContentVersion: 1,
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
        expectedContentVersion: 1,
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
          expectedContentVersion: 1,
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
        expectedContentVersion: 1,
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

  it('approves only the revision version the reviewer saw', () => {
    const db = database()
    seedRevision(db, 'pending_review')
    execute(
      db,
      buildReplaceRevisionContentPlans({
        authorUserId: 'user_owner',
        content: { ...content, name: 'Changed after review began' },
        now: NOW,
        revisionId
      })
    )
    expect(revision(db)?.content_version).toBe(2)
    const approve = (expectedContentVersion: number) =>
      buildApproveRevisionPlans({
        expectedContentVersion,
        listingId,
        now: NOW,
        publication: publication('revision-approval'),
        reviewer: 'reviewer',
        revisionId
      })
    expect(() => execute(db, approve(1))).toThrow(/malformed JSON/u)
    expect(db.prepare('SELECT name FROM listings').get()).toEqual({ name: `Live ${listingId}` })
    execute(db, approve(2))
    expect(db.prepare('SELECT name FROM listings').get()).toEqual({
      name: 'Changed after review began'
    })
  })

  it('requires a logo on every revision, so approval never removes the listing logo', () => {
    const db = database()
    seedRevision(db, 'pending_review')
    expect(() =>
      db.prepare('UPDATE listing_revisions SET logo_url=NULL WHERE id=?').run(revisionId)
    ).toThrow(/NOT NULL constraint failed: listing_revisions.logo_url/u)
  })
})

describe('one staged-edit channel per listing (#62 review, finding 1)', () => {
  const submissionId = '44444444-4444-4444-8444-444444444444'
  const paidListing = `submission_${submissionId}`

  /** A paid draft published before review: live, owned by the payer, `paid_pending_review`. */
  function paidLiveListing(): DatabaseSync {
    const db = planDatabase()
    db.prepare(
      `INSERT INTO listing_submissions (id,slug,block_key,block_covers_subdomains,name,description,website,content,
        category_slug,logo_url,status,plan,owner_user_id,draft_saved_at)
      VALUES (?,'paid.example','paid.example',1,'Paid','Submitted description',
        'https://paid.example/','Submitted content','tools','https://paid.example/logo.png',
        'draft','paid','user_owner',?)`
    ).run(submissionId, NOW)
    execute(
      db,
      buildRecordSubmissionPaymentPlans({
        actor: 'stripe',
        listingId: paidListing,
        now: NOW,
        outcome: 'publish',
        publication: publication('paid-listing'),
        submissionId
      })
    )
    return db
  }

  const create = () =>
    buildCreateRevisionPlans({
      authorUserId: 'user_owner',
      content: { ...content, name: 'Revised by owner' },
      listingId: paidListing,
      now: NOW,
      revisionId
    })

  it("refuses a revision while the listing's own submission is in review", () => {
    const db = paidLiveListing()
    expect(db.prepare('SELECT status FROM listing_submissions').get()).toEqual({
      status: 'paid_pending_review'
    })
    expect(() => execute(db, create())).toThrow(/malformed JSON/u)
    db.prepare("UPDATE listing_submissions SET status='changes_requested' WHERE id=?").run(
      submissionId
    )
    expect(() => execute(db, create())).toThrow(/malformed JSON/u)
    expect(count(db, 'SELECT COUNT(*) AS count FROM listing_revisions')).toBe(0)
  })

  it('opens revisions once the submission is approved, without losing either edit', () => {
    const db = paidLiveListing()
    const state = publicationState(db)
    execute(
      db,
      buildApproveLiveSubmissionPlans({
        expectedContentVersion: 1,
        listingId: paidListing,
        now: NOW,
        publication: publication('live-approval', state),
        reviewer: 'reviewer',
        submissionId
      })
    )
    execute(db, create())
    const approved = publicationState(db)
    execute(
      db,
      buildApproveRevisionPlans({
        expectedContentVersion: 1,
        listingId: paidListing,
        now: NOW,
        publication: publication('revision-approval', approved),
        reviewer: 'reviewer',
        revisionId
      })
    )
    expect(db.prepare('SELECT name FROM listings WHERE id=?').get(paidListing)).toEqual({
      name: 'Revised by owner'
    })
  })

  it('refuses a live approval after the listing changed under the submission', () => {
    const db = paidLiveListing()
    // An admin manifest edit while the submission waits for review.
    db.prepare("UPDATE listings SET name='Admin edit', checksum='manifest' WHERE id=?").run(
      paidListing
    )
    expect(() =>
      execute(
        db,
        buildApproveLiveSubmissionPlans({
          expectedContentVersion: 1,
          listingId: paidListing,
          now: NOW,
          publication: publication('live-approval', publicationState(db)),
          reviewer: 'reviewer',
          submissionId
        })
      )
    ).toThrow(/malformed JSON/u)
    expect(db.prepare('SELECT name FROM listings WHERE id=?').get(paidListing)).toEqual({
      name: 'Admin edit'
    })
  })
})

describe("a revision's or claim's logo at approval (#96 review round 4, S1)", () => {
  const sha = (fill: string) => fill.repeat(64)
  const hostedLogo = (scope: string, owner: string, fill: string, sourceUrl: string) => ({
    bytes: 10,
    contentType: 'image/png',
    height: 64,
    key: `best.serp.co/${scope}/${owner}/logo/${fill.repeat(16)}.png`,
    sha256: sha(fill),
    sourceUrl,
    width: 64
  })
  const logoRows = (db: DatabaseSync, id = listingId) =>
    db.prepare("SELECT url,media_key FROM listing_media WHERE listing_id=? AND kind='logo'").all(id)
  const logoQueue = (db: DatabaseSync, id = listingId) =>
    db
      .prepare(
        "SELECT source_url,copy_from_key FROM media_ingestions WHERE listing_id=? AND kind='logo'"
      )
      .all(id)
  const approve = (db: DatabaseSync, expectedLogoKey: string | null) =>
    execute(
      db,
      buildApproveRevisionPlans({
        expectedContentVersion: 1,
        expectedLogoKey,
        listingId,
        now: NOW,
        publication: publication('revision-approval', publicationState(db)),
        reviewer: 'reviewer',
        revisionId
      })
    )

  it('adopts exactly the copy hosted when the revision was saved', () => {
    const db = database()
    seedRevision(db, 'pending_review')
    const saved = hostedLogo('revisions', revisionId, 'a', content.logoUrl)
    execute(
      db,
      buildRecordPendingMediaPlans({
        kind: 'logo',
        media: saved,
        now: NOW,
        owner: { revisionId },
        sortOrder: 0
      })
    )
    // Another key than the one the reviewer saw (or none) refuses the approval.
    expect(() => approve(db, null)).toThrow(/malformed JSON/u)
    expect(() =>
      approve(db, hostedLogo('revisions', revisionId, 'b', content.logoUrl).key)
    ).toThrow(/malformed JSON/u)
    approve(db, saved.key)
    // The old logo gives way to a copy of the reviewed bytes into the listing's path.
    expect(logoRows(db)).toEqual([])
    expect(logoQueue(db)).toEqual([{ copy_from_key: saved.key, source_url: content.logoUrl }])
  })

  it("keeps the listing's hosted logo when the revision kept its source", () => {
    const db = database()
    const current = hostedLogo('listings', `${listingId}.example`, 'c', content.logoUrl)
    db.prepare(
      `UPDATE listing_media SET url=?,media_key=?,sha256=?,content_type=?,bytes=?,width=?,height=?
       WHERE listing_id=? AND kind='logo'`
    ).run(
      content.logoUrl,
      current.key,
      current.sha256,
      current.contentType,
      current.bytes,
      current.width,
      current.height,
      listingId
    )
    seedRevision(db, 'pending_review')
    approve(db, current.key)
    expect(logoRows(db)).toEqual([{ media_key: current.key, url: content.logoUrl }])
    expect(logoQueue(db)).toEqual([])
  })

  it('keeps the current logo, and its queue, when nothing reviewed is adopted', () => {
    const db = database()
    seedRevision(db, 'pending_review')
    // An admin's replacement already waits on the listing's slot.
    execute(
      db,
      buildQueueMediaPlans({
        kind: 'logo',
        now: NOW,
        sortOrder: 0,
        sourceUrl: 'https://assets.example/admin-logo.png',
        target: { listingId }
      })
    )
    approve(db, null)
    expect(logoRows(db)).toEqual([{ media_key: null, url: 'https://assets.example/old-logo.png' }])
    expect(logoQueue(db)).toEqual([
      { copy_from_key: null, source_url: 'https://assets.example/admin-logo.png' }
    ])
  })

  it('keeps the current logo when a claim approval has no hosted logo', () => {
    const submissionId = '55555555-5555-4555-8555-555555555555'
    const claimed = `submission_${submissionId}`
    const db = planDatabase()
    db.prepare(
      `INSERT INTO listing_submissions (id,slug,block_key,block_covers_subdomains,name,description,website,content,
        category_slug,logo_url,status,plan,owner_user_id,draft_saved_at)
      VALUES (?,'claim.example','claim.example',1,'Claim','Submitted description',
        'https://claim.example/','Submitted content','tools','https://claim.example/new.png',
        'draft','paid','user_owner',?)`
    ).run(submissionId, NOW)
    execute(
      db,
      buildRecordSubmissionPaymentPlans({
        actor: 'stripe',
        listingId: claimed,
        now: NOW,
        outcome: 'publish',
        publication: publication('paid-listing'),
        submissionId
      })
    )
    const current = hostedLogo('listings', 'claim.example', 'd', 'https://claim.example/old.png')
    db.prepare(
      `INSERT INTO listing_media (listing_id,kind,url,sort_order,media_key,sha256,content_type,
        bytes,width,height) VALUES (?,'logo',?,0,?,?,?,?,?,?)`
    ).run(
      claimed,
      current.sourceUrl,
      current.key,
      current.sha256,
      current.contentType,
      current.bytes,
      current.width,
      current.height
    )
    execute(
      db,
      buildApproveLiveSubmissionPlans({
        expectedContentVersion: 1,
        expectedLogoKey: null,
        listingId: claimed,
        now: NOW,
        publication: publication('live-approval', publicationState(db)),
        reviewer: 'reviewer',
        submissionId
      })
    )
    expect(logoRows(db, claimed)).toEqual([{ media_key: current.key, url: current.sourceUrl }])
    expect(logoQueue(db, claimed)).toEqual([])
  })
})

describe("a revision's tags and the stale-slug resolver (#341, design 4.4)", () => {
  function tagged(listingTagSlugs: string[]): DatabaseSync {
    const db = database()
    seedTags(db)
    listingTagSlugs.forEach((slug, order) => {
      db.prepare(
        `INSERT INTO listing_tags (listing_id,tag_id,sort_order)
        SELECT ?,id,? FROM tags WHERE slug=?`
      ).run(listingId, order, slug)
    })
    return db
  }

  function approve(db: DatabaseSync, staged: Partial<StagedListingContent>): void {
    execute(
      db,
      buildCreateRevisionPlans({
        authorUserId: 'user_owner',
        content: { ...content, ...staged },
        listingId,
        now: NOW,
        revisionId
      })
    )
    execute(
      db,
      buildApproveRevisionPlans({
        expectedContentVersion: 1,
        listingId,
        now: NOW,
        publication: publication('revision-approval'),
        reviewer: 'reviewer',
        revisionId
      })
    )
  }

  it('stores the tags, or null when not given', () => {
    const db = tagged([])
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
    expect(revision(db)?.tag_slugs).toBeNull()
    execute(
      db,
      buildReplaceRevisionContentPlans({
        authorUserId: 'user_owner',
        content: { ...content, tagSlugs: ['whiteboards'] },
        now: NOW,
        revisionId
      })
    )
    expect(revision(db)?.tag_slugs).toBe('["whiteboards"]')
  })

  it('replaces the tags when the revision gives them, from 0, an empty list included', () => {
    const db = tagged(['note-taking'])
    approve(db, { tagSlugs: ['whiteboards', 'retired-tag', 'note-taking'] })
    expect(listingTagOrder(db, listingId)).toEqual([
      { slug: 'whiteboards', sort_order: 0 },
      { slug: 'note-taking', sort_order: 1 }
    ])
    const emptied = tagged(['note-taking'])
    approve(emptied, { tagSlugs: [] })
    expect(listingTagOrder(emptied, listingId)).toEqual([])
  })

  it('leaves the tags as they are when the revision gives none', () => {
    const db = tagged(['note-taking', 'whiteboards'])
    approve(db, { tagSlugs: null })
    expect(listingTagOrder(db, listingId)).toEqual([
      { slug: 'note-taking', sort_order: 0 },
      { slug: 'whiteboards', sort_order: 1 }
    ])
  })

  it("files a retired narrow slug under its hub, appending its tag after the listing's own", () => {
    const db = tagged(['note-taking', 'whiteboards'])
    approve(db, { categorySlug: 'chatbots', tagSlugs: null })
    expect(primaryCategory(db, listingId)).toBe('apps')
    expect(listingTagOrder(db, listingId)).toEqual([
      { slug: 'note-taking', sort_order: 0 },
      { slug: 'whiteboards', sort_order: 1 },
      { slug: 'chatbots', sort_order: 2 }
    ])
    expect(publicationState(db).version).toBe(2)
    // Already there, it stays where it is.
    const kept = tagged(['whiteboards', 'chatbots'])
    approve(kept, { categorySlug: 'chatbots', tagSlugs: null })
    expect(listingTagOrder(kept, listingId)).toEqual([
      { slug: 'whiteboards', sort_order: 0 },
      { slug: 'chatbots', sort_order: 1 }
    ])
  })

  it('puts the resolver tag first when the revision gives tags, a merged slug included', () => {
    const db = tagged(['whiteboards'])
    approve(db, { categorySlug: 'merged-narrow', tagSlugs: ['whiteboards', 'note-taking'] })
    // `merged-narrow` redirects to the tag `note-taking` (Tools).
    expect(primaryCategory(db, listingId)).toBe('tools')
    expect(listingTagOrder(db, listingId)).toEqual([
      { slug: 'note-taking', sort_order: 0 },
      { slug: 'whiteboards', sort_order: 1 }
    ])
  })
})

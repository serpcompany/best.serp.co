import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import type { StatementPlan } from './plan-support'
import {
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
import { type SubmissionStatus, submissionStatuses } from './schema'
import {
  buildApproveLiveSubmissionPlans,
  buildApproveSubmissionPlans,
  buildChooseSubmissionPlanPlans,
  buildClaimListingBadgeCheckPlans,
  buildClearDraftPlans,
  buildFinishListingBadgeCheckPlans,
  buildLiftSubmissionUrlBlockPlans,
  buildRecordSubmissionPaymentPlans,
  buildRecordUnappliedPaymentPlans,
  buildRefundSubmissionPlans,
  buildRejectSubmissionPlans,
  buildReplaceSubmissionContentPlans,
  buildReplaceSubmissionExtrasPlans,
  buildRequestSubmissionChangesPlans,
  buildResubmitSubmissionPlans,
  buildUpgradeListingToPaidPlans,
  buildWithdrawSubmissionPlans,
  LISTING_BADGE_CHECK_ACTOR,
  type ListingBadgeCheckClaim,
  selectRefundPendingSubmissionsPlan,
  selectSubmissionForDecisionPlan,
  submissionTransitions
} from './submission-plans'

const submissionId = '11111111-1111-4111-8111-111111111111'
const liveListingId = `submission_${submissionId}`
const liveChecksum = `checksum-${liveListingId}`

/** A draft saved one day before `NOW`: inside the 30-day draft clock. */
const RECENT_DRAFT = '2026-10-05T12:00:00.000Z'

interface SeedOptions {
  /** The plan a draft has chosen so far (default: none). */
  draftPlan?: 'paid' | null
  /** When a draft was saved (default: `RECENT_DRAFT`). */
  draftSavedAt?: string
  live?: boolean
  owner?: string | null
  paid?: boolean
}

/**
 * Inserts the fixture submission in `status`, satisfying the table's CHECK constraints:
 * `paid_pending_review` is always live and paid (with its published checksum), `approved` is
 * live, `rejected` carries an `other` category, a `draft` is never paid or live and has an owner,
 * a clock, and a block key, `pending_badge` is never paid, and `withdrawn` (by its owner) is
 * unpaid. Other statuses are free, unpaid, and not live unless asked.
 */
function seedSubmission(
  db: DatabaseSync,
  status: SubmissionStatus,
  options: SeedOptions = {}
): void {
  const unpayable = status === 'draft' || status === 'pending_badge' || status === 'withdrawn'
  const live =
    status === 'paid_pending_review' ||
    (status !== 'draft' && status !== 'withdrawn' && (options.live ?? status === 'approved'))
  const paid = status === 'paid_pending_review' || (!unpayable && (options.paid ?? false))
  const plan = status === 'draft' ? (options.draftPlan ?? null) : paid ? 'paid' : 'free'
  if (live) {
    seedLiveListing(db, liveListingId, { slug: 'example.com' })
    db.prepare(
      "UPDATE listings SET source='submission', link_rel='nofollow', source_kind='verified-submission', source_identity=? WHERE id=?"
    ).run(submissionId, liveListingId)
  }
  db.prepare(
    `INSERT INTO listing_submissions
      (id,slug,block_key,block_covers_subdomains,name,description,website,content,category_slug,logo_url,status,
       badge_verified_at,listing_id,owner_user_id,plan,paid_at,
       rejection_reason,rejection_category,draft_saved_at,withdrawal_reason,published_checksum)
    VALUES (?,'example.com','example.com',1,'Example','Description','https://example.com/','Content',
      'tools','https://example.com/logo.png',?,'2026-08-01T00:00:00.000Z',?,?,?,?,?,?,?,?,?)`
  ).run(
    submissionId,
    status,
    live ? liveListingId : null,
    options.owner === undefined || status === 'draft' ? 'user_owner' : options.owner,
    plan,
    paid ? '2026-08-01T00:00:00.000Z' : null,
    status === 'rejected' ? 'Spam' : null,
    status === 'rejected' ? 'other' : null,
    status === 'draft' ? (options.draftSavedAt ?? RECENT_DRAFT) : null,
    status === 'withdrawn' ? 'owner' : null,
    live && paid ? liveChecksum : null
  )
  db.prepare(
    `INSERT INTO listing_submission_resource_links(submission_id,label,url,sort_order)
    VALUES (?,'Docs','https://example.com/docs',0)`
  ).run(submissionId)
  db.prepare(
    `INSERT INTO listing_submission_faqs(submission_id,question,answer,sort_order)
    VALUES (?,'Question','Answer',0)`
  ).run(submissionId)
}

function database(status: SubmissionStatus = 'verified', options: SeedOptions = {}): DatabaseSync {
  const db = planDatabase()
  seedSubmission(db, status, options)
  return db
}

function submission(db: DatabaseSync): Record<string, unknown> {
  return db.prepare('SELECT * FROM listing_submissions WHERE id=?').get(submissionId) as Record<
    string,
    unknown
  >
}

function events(db: DatabaseSync, eventType?: string): number {
  return eventType
    ? count(
        db,
        'SELECT COUNT(*) AS count FROM listing_submission_events WHERE event_type=?',
        eventType
      )
    : count(db, 'SELECT COUNT(*) AS count FROM listing_submission_events')
}

function listing(db: DatabaseSync, id = liveListingId): Record<string, unknown> | undefined {
  return db.prepare('SELECT * FROM listings WHERE id=?').get(id) as
    | Record<string, unknown>
    | undefined
}

function approvalPlans(expectedContentVersion = 1) {
  const afterChecksum = createHash('sha256').update('after').digest('hex')
  return buildApproveSubmissionPlans({
    afterChecksum,
    affectedRoute: '/products/example.com/',
    beforeChecksum: 'before',
    expectedContentVersion,
    listingId: liveListingId,
    manifestId: `verified-submission-${submissionId}`,
    now: '2026-08-01T01:00:00.000Z',
    reviewer: 'reviewer',
    runId: `submission_publish_${submissionId}`,
    submissionId,
    version: 1,
    workflow: 'app/admin'
  })
}

function approveLivePlans(expectedContentVersion = 1) {
  return buildApproveLiveSubmissionPlans({
    expectedContentVersion,
    listingId: liveListingId,
    now: NOW,
    publication: publication('live-submission-approval'),
    reviewer: 'reviewer',
    submissionId
  })
}

const content = {
  categorySlug: 'apps',
  content: 'New content',
  description: 'New description',
  faqs: [{ answer: 'A1', question: 'Q1' }],
  logoUrl: 'https://example.com/new-logo.png',
  name: 'New name',
  resourceLinks: [
    { label: 'Pricing', url: 'https://example.com/pricing' },
    { label: 'Docs', url: 'https://example.com/docs' }
  ]
}

/**
 * For each status, runs `plans` against a fixture in that status. The statuses in `succeeds`
 * must transition (status and one event); every other status must fail the compare-and-swap,
 * roll back, and leave the row and its events untouched.
 */
function expectTransition(spec: {
  after: (db: DatabaseSync, from: SubmissionStatus) => void
  event: string
  plans: () => StatementPlan[]
  seed?: SeedOptions
  succeeds: readonly SubmissionStatus[]
}): void {
  for (const status of submissionStatuses) {
    const db = database(status, spec.seed)
    const before = submission(db)
    const eventsBefore = events(db)
    const versionBefore = publicationState(db)
    if (spec.succeeds.includes(status)) {
      execute(db, spec.plans())
      expect(events(db, spec.event), `${status}: ${spec.event} event`).toBeGreaterThanOrEqual(1)
      spec.after(db, status)
    } else {
      expect(() => execute(db, spec.plans()), `${status} must be refused`).toThrow(
        /malformed JSON/u
      )
      expect(submission(db), `${status} row unchanged`).toEqual(before)
      expect(events(db), `${status} events unchanged`).toBe(eventsBefore)
      expect(publicationState(db)).toEqual(versionBefore)
      expect(count(db, 'SELECT COUNT(*) AS count FROM publication_runs')).toBe(0)
    }
    db.close()
  }
}

describe('submission transition map', () => {
  it('names only real statuses, and only payment bookkeeping leaves a final status', () => {
    for (const [action, transition] of Object.entries(submissionTransitions)) {
      for (const from of transition.from) expect(submissionStatuses, action).toContain(from)
    }
    // The owner's badge check of a live listing (#65) records counters and an event only.
    const bookkeeping = ['listingBadgeCheck', 'refund', 'payUnapplied', 'upgradeListing']
    for (const terminal of ['approved', 'rejected', 'withdrawn'] as const) {
      const outgoing = Object.entries(submissionTransitions).filter(
        ([action, transition]) =>
          !bookkeeping.includes(action) && (transition.from as readonly string[]).includes(terminal)
      )
      expect(outgoing, `${terminal} is final for review`).toEqual([])
    }
    expect(submissionTransitions.ownerEdit.from).not.toContain('verified')
    expect(submissionTransitions.ownerEdit.from).not.toContain('paid_pending_review')
    // In the queue, the owner may add FAQs and links (#65) but never edit the rest.
    expect(submissionTransitions.ownerExtras.from).toEqual(['verified', 'paid_pending_review'])
  })

  // #77: a plan's statement count follows the staged children, so builders cap them.
  it('refuses staged content with more than five resource links or FAQs', () => {
    const plans = (overrides: Partial<typeof content>) =>
      buildReplaceSubmissionContentPlans({
        actor: 'reviewer',
        content: { ...content, ...overrides },
        expectedStatuses: ['verified'],
        now: NOW,
        submissionId
      })
    const link = { label: 'Docs', url: 'https://example.com/docs' }
    const faq = { answer: 'Yes.', question: 'Free?' }
    expect(() => plans({ resourceLinks: Array(6).fill(link) })).toThrow(/at most 5 resource links/u)
    expect(() => plans({ faqs: Array(6).fill(faq) })).toThrow(/at most 5 FAQs/u)
    expect(plans({ faqs: Array(5).fill(faq), resourceLinks: Array(5).fill(link) })).toHaveLength(15)
  })
})

describe('submission status transitions (compare-and-swap with changes() assertions)', () => {
  it('approves only a verified submission: listing created nofollow, submitter made owner', () => {
    expectTransition({
      after: db => {
        expect(submission(db)).toMatchObject({ listing_id: liveListingId, status: 'approved' })
        expect(listing(db)).toMatchObject({
          link_rel: 'nofollow',
          source: 'submission',
          source_identity: submissionId,
          status: 'approved'
        })
        expect(
          db.prepare('SELECT user_id,verified_via,revoked_at FROM listing_owners').all()
        ).toEqual([{ revoked_at: null, user_id: 'user_owner', verified_via: 'submission' }])
        expect(publicationState(db).version).toBe(2)
      },
      event: 'approved',
      plans: approvalPlans,
      seed: { live: false },
      succeeds: ['verified']
    })
  })

  it('approves only the content version the reviewer saw', () => {
    const db = database('verified')
    execute(
      db,
      buildReplaceSubmissionContentPlans({
        actor: 'reviewer',
        content,
        expectedContentVersion: 1,
        expectedStatuses: ['verified'],
        now: NOW,
        submissionId
      })
    )
    expect(submission(db).content_version).toBe(2)
    expect(() => execute(db, approvalPlans(1))).toThrow(/malformed JSON/u)
    expect(count(db, 'SELECT COUNT(*) AS count FROM listings')).toBe(0)
    execute(db, approvalPlans(2))
    expect(listing(db)).toMatchObject({ name: 'New name', status: 'approved' })
    expect(() => approvalPlans(0)).toThrow(/positive integer/u)
  })

  it("approves with a reviewer's edits and chosen link in one batch (#64)", () => {
    const db = database('verified')
    const edits = buildReplaceSubmissionContentPlans({
      actor: 'reviewer',
      content,
      eventDetail: JSON.stringify({ fields: ['name'] }),
      expectedContentVersion: 1,
      expectedStatuses: ['verified'],
      now: NOW,
      submissionId
    })
    const approve = buildApproveSubmissionPlans({
      afterChecksum: createHash('sha256').update('after').digest('hex'),
      affectedRoute: '/products/example.com/',
      beforeChecksum: 'before',
      expectedContentVersion: 2,
      linkRel: 'sponsored',
      listingId: liveListingId,
      manifestId: `admin-approve-${submissionId}`,
      now: NOW,
      reviewer: 'reviewer',
      runId: `admin_approve_${submissionId}`,
      submissionId,
      version: 1,
      workflow: 'app/admin'
    })
    execute(db, [...edits, ...approve])
    expect(listing(db)).toMatchObject({ link_rel: 'sponsored', name: 'New name' })
    expect(
      db
        .prepare(
          "SELECT detail FROM listing_submission_events WHERE event_type='edited' ORDER BY id"
        )
        .all()
    ).toEqual([{ detail: JSON.stringify({ fields: ['name'] }) }])
    // A replay of the same batch is refused whole: the version moved on.
    expect(() => execute(db, [...edits, ...approve])).toThrow(/malformed JSON/u)
    expect(count(db, 'SELECT COUNT(*) AS count FROM listings')).toBe(1)
    expect(() =>
      buildApproveSubmissionPlans({
        afterChecksum: 'a',
        affectedRoute: '/',
        beforeChecksum: 'b',
        expectedContentVersion: 1,
        linkRel: 'ugc' as 'follow',
        listingId: 'l',
        manifestId: 'm',
        now: NOW,
        reviewer: 'r',
        runId: 'r',
        submissionId,
        version: 1,
        workflow: 'app/admin'
      })
    ).toThrow(/follow, nofollow, or sponsored/u)
  })

  it('records a payment as live and queued, or held for review, from every payable status', () => {
    expectTransition({
      after: db => {
        expect(submission(db)).toMatchObject({
          listing_id: liveListingId,
          paid_at: NOW,
          plan: 'paid',
          published_checksum: publication('paid-listing').afterChecksum,
          status: 'paid_pending_review'
        })
        expect(listing(db)).toMatchObject({
          checksum: publication('paid-listing').afterChecksum,
          is_active: 1,
          link_rel: 'nofollow',
          status: 'approved'
        })
        expect(count(db, 'SELECT COUNT(*) AS count FROM listing_owners')).toBe(1)
        expect(publicationState(db).version).toBe(2)
        // Live before review: no featured image is adopted until a reviewer has seen it.
        expect(
          count(db, 'SELECT COUNT(*) AS count FROM media_ingestions WHERE listing_id IS NOT NULL')
        ).toBe(0)
        expect(
          JSON.stringify(
            buildRecordSubmissionPaymentPlans({
              actor: 'stripe',
              listingId: liveListingId,
              now: NOW,
              outcome: 'publish',
              publication: publication('paid-listing'),
              submissionId
            })
          )
        ).not.toContain('reviewed_image_current')
      },
      event: 'paid',
      plans: () =>
        buildRecordSubmissionPaymentPlans({
          actor: 'stripe',
          listingId: liveListingId,
          now: NOW,
          outcome: 'publish',
          publication: publication('paid-listing'),
          submissionId
        }),
      seed: { draftPlan: 'paid', live: false, paid: false },
      succeeds: submissionTransitions.payPublish.from
    })
    expectTransition({
      after: db => {
        expect(submission(db)).toMatchObject({
          listing_id: null,
          paid_at: NOW,
          plan: 'paid',
          status: 'verified'
        })
        expect(publicationState(db).version).toBe(1)
      },
      event: 'paid',
      plans: () =>
        buildRecordSubmissionPaymentPlans({
          actor: 'stripe',
          now: NOW,
          outcome: 'hold',
          submissionId
        }),
      seed: { draftPlan: 'paid', live: false, paid: false },
      succeeds: submissionTransitions.payHold.from
    })
  })

  it('records a payment once, and never for a draft without the paid plan', () => {
    const hold = () =>
      buildRecordSubmissionPaymentPlans({
        actor: 'stripe',
        now: NOW,
        outcome: 'hold',
        submissionId
      })
    const db = database('draft', { draftPlan: 'paid' })
    execute(db, hold())
    expect(() => execute(db, hold())).toThrow(/malformed JSON/u)
    expect(events(db, 'paid')).toBe(1)

    const unchosen = database('draft', { draftPlan: null })
    expect(() => execute(unchosen, hold())).toThrow(/malformed JSON/u)
    expect(submission(unchosen)).toMatchObject({ paid_at: null, plan: null, status: 'draft' })
  })

  it('applies a checkout that completes after the draft switched to free (upgrade path)', () => {
    const db = database('draft', { draftPlan: 'paid' })
    execute(
      db,
      buildChooseSubmissionPlanPlans({
        now: NOW,
        ownerUserId: 'user_owner',
        plan: 'free',
        submissionId
      })
    )
    expect(submission(db)).toMatchObject({ plan: 'free', status: 'pending_badge' })
    execute(
      db,
      buildRecordSubmissionPaymentPlans({
        actor: 'stripe',
        now: NOW,
        outcome: 'hold',
        submissionId
      })
    )
    expect(submission(db)).toMatchObject({ paid_at: NOW, plan: 'paid', status: 'verified' })
  })

  it('records and refunds a payment that completes after the submission was withdrawn', () => {
    expectTransition({
      after: db => {
        expect(submission(db)).toMatchObject({
          paid_at: NOW,
          refunded_at: NOW,
          status: 'withdrawn',
          withdrawal_reason: 'owner'
        })
        expect(events(db, 'refunded')).toBe(1)
      },
      event: 'paid',
      plans: () => buildRecordUnappliedPaymentPlans({ actor: 'stripe', now: NOW, submissionId }),
      succeeds: submissionTransitions.payUnapplied.from
    })
    // A withdrawn submission never holds an unrefunded payment.
    const db = database('withdrawn')
    expect(() =>
      db
        .prepare("UPDATE listing_submissions SET paid_at=?, plan='paid' WHERE id=?")
        .run(NOW, submissionId)
    ).toThrow(/listing_submissions_withdrawn_unpaid/u)
  })

  it('upgrades a live approved free listing to the paid plan without a publication', () => {
    expectTransition({
      after: db => {
        expect(submission(db)).toMatchObject({ paid_at: NOW, plan: 'paid', status: 'approved' })
        expect(publicationState(db).version).toBe(1)
      },
      event: 'paid',
      plans: () => buildUpgradeListingToPaidPlans({ actor: 'stripe', now: NOW, submissionId }),
      seed: { live: true, paid: false },
      succeeds: submissionTransitions.upgradeListing.from
    })
    const paid = database('approved', { paid: true })
    expect(() =>
      execute(paid, buildUpgradeListingToPaidPlans({ actor: 'stripe', now: NOW, submissionId }))
    ).toThrow(/malformed JSON/u)
  })

  it('records the plan choice on a draft: free starts the badge step, paid awaits checkout', () => {
    const choose = (plan: 'free' | 'paid', owner = 'user_owner') =>
      buildChooseSubmissionPlanPlans({ now: NOW, ownerUserId: owner, plan, submissionId })
    expectTransition({
      after: db => expect(submission(db)).toMatchObject({ plan: 'free', status: 'pending_badge' }),
      event: 'plan_chosen',
      plans: () => choose('free'),
      succeeds: submissionTransitions.chooseFree.from
    })
    expectTransition({
      after: db =>
        expect(submission(db)).toMatchObject({ paid_at: null, plan: 'paid', status: 'draft' }),
      event: 'plan_chosen',
      plans: () => choose('paid'),
      succeeds: submissionTransitions.choosePaid.from
    })
    const db = database('draft', { draftPlan: 'paid' })
    expect(() => execute(db, choose('free', 'user_other'))).toThrow(/malformed JSON/u)
    execute(db, choose('free'))
    expect(submission(db)).toMatchObject({ plan: 'free', status: 'pending_badge' })
  })

  it('holds a draft’s URL against duplicates until it is withdrawn', () => {
    const db = database('draft')
    expect(() =>
      db
        .prepare(
          `INSERT INTO listing_submissions (id,slug,name,description,website,content,category_slug,
            logo_url) VALUES (?,'example.com','Again','d','https://example.com/','c','tools','l')`
        )
        .run(crypto.randomUUID())
    ).toThrow(/UNIQUE constraint failed: listing_submissions.slug/u)
    execute(db, buildWithdrawSubmissionPlans({ now: NOW, ownerUserId: 'user_owner', submissionId }))
    expect(submission(db)).toMatchObject({ status: 'withdrawn', withdrawal_reason: 'owner' })
  })

  it('lets an admin clear a draft, freeing its URL key', () => {
    expectTransition({
      after: db => {
        expect(submission(db)).toMatchObject({ status: 'withdrawn', withdrawal_reason: 'admin' })
        expect(
          db
            .prepare(
              "SELECT actor,detail FROM listing_submission_events WHERE event_type='withdrawn'"
            )
            .get()
        ).toEqual({ actor: 'admin@example.com', detail: '{"by":"admin","note":"Squatting."}' })
      },
      event: 'withdrawn',
      plans: () =>
        buildClearDraftPlans({
          admin: 'admin@example.com',
          note: 'Squatting.',
          now: NOW,
          submissionId
        }),
      succeeds: submissionTransitions.clearDraft.from
    })
    expect(() => buildClearDraftPlans({ admin: 'a', note: ' ', now: NOW, submissionId })).toThrow(
      /note/u
    )
  })

  it('approves a live paid submission by applying its staged content', () => {
    expectTransition({
      after: db => {
        expect(submission(db)).toMatchObject({ reviewed_by: 'reviewer', status: 'approved' })
        expect(listing(db)).toMatchObject({ is_active: 1, name: 'Example', status: 'approved' })
        expect(publicationState(db).version).toBe(2)
      },
      event: 'approved',
      plans: () => approveLivePlans(),
      seed: { live: true, paid: true },
      succeeds: submissionTransitions.approveLive.from
    })
  })

  it('refuses a live approval when the listing changed since it was published', () => {
    const db = database('paid_pending_review')
    db.prepare("UPDATE listings SET name='Edited by admin', checksum='manifest' WHERE id=?").run(
      liveListingId
    )
    expect(() => execute(db, approveLivePlans())).toThrow(/malformed JSON/u)
    expect(listing(db)).toMatchObject({ name: 'Edited by admin' })
    expect(submission(db).status).toBe('paid_pending_review')

    const stale = database('paid_pending_review')
    stale.prepare('UPDATE listing_submissions SET content_version=2 WHERE id=?').run(submissionId)
    expect(() => execute(stale, approveLivePlans(1))).toThrow(/malformed JSON/u)
    execute(stale, approveLivePlans(2))
    expect(submission(stale).status).toBe('approved')
  })

  it('requests changes only from the review queue, with a note', () => {
    expectTransition({
      after: (db, from) => {
        expect(submission(db)).toMatchObject({
          listing_id: from === 'paid_pending_review' ? liveListingId : null,
          reviewer_note: 'Add a clearer description.',
          status: 'changes_requested'
        })
      },
      event: 'changes_requested',
      plans: () =>
        buildRequestSubmissionChangesPlans({
          note: 'Add a clearer description.',
          now: NOW,
          reviewer: 'reviewer',
          submissionId
        }),
      succeeds: submissionTransitions.requestChanges.from
    })
    expect(() =>
      buildRequestSubmissionChangesPlans({ note: ' ', now: NOW, reviewer: 'r', submissionId })
    ).toThrow(/note/u)
  })

  it('resubmits back to the queue it left, only while its listing is live, for the owner', () => {
    const plans = () =>
      buildResubmitSubmissionPlans({ now: NOW, ownerUserId: 'user_owner', submissionId })
    expectTransition({
      after: db => expect(submission(db).status).toBe('verified'),
      event: 'resubmitted',
      plans,
      seed: { live: false },
      succeeds: submissionTransitions.resubmit.from
    })
    const live = database('changes_requested', { live: true, paid: true })
    execute(live, plans())
    expect(submission(live).status).toBe('paid_pending_review')

    // Taken down outside the plans (for example, a publication manifest): no resubmission.
    const down = database('changes_requested', { live: true, paid: true })
    down.prepare('UPDATE listings SET is_active=0 WHERE id=?').run(liveListingId)
    expect(() => execute(down, plans())).toThrow(/malformed JSON/u)
    expect(submission(down).status).toBe('changes_requested')

    const stranger = database('changes_requested')
    expect(() =>
      execute(
        stranger,
        buildResubmitSubmissionPlans({ now: NOW, ownerUserId: 'user_other', submissionId })
      )
    ).toThrow(/malformed JSON/u)
  })

  it('withdraws only an unpaid, unpublished submission, for its owner', () => {
    expectTransition({
      after: db =>
        expect(submission(db)).toMatchObject({ status: 'withdrawn', withdrawal_reason: 'owner' }),
      event: 'withdrawn',
      plans: () =>
        buildWithdrawSubmissionPlans({ now: NOW, ownerUserId: 'user_owner', submissionId }),
      seed: { live: false, paid: false },
      succeeds: submissionTransitions.withdraw.from
    })
    for (const [status, options] of [
      ['verified', { paid: true }],
      ['changes_requested', { live: true, paid: true }]
    ] as const) {
      const db = database(status, options)
      expect(() =>
        execute(
          db,
          buildWithdrawSubmissionPlans({ now: NOW, ownerUserId: 'user_owner', submissionId })
        )
      ).toThrow(/malformed JSON/u)
      expect(submission(db).status).toBe(status)
    }
  })

  it('rejects an unpublished submission with a reason and category', () => {
    expectTransition({
      after: db => {
        expect(submission(db)).toMatchObject({
          rejection_category: 'other',
          rejection_reason: 'Not a software product.',
          status: 'rejected'
        })
        expect(count(db, 'SELECT COUNT(*) AS count FROM listing_submission_url_blocks')).toBe(0)
      },
      event: 'rejected',
      plans: () =>
        buildRejectSubmissionPlans({
          category: 'other',
          now: NOW,
          reason: 'Not a software product.',
          reviewer: 'reviewer',
          submissionId
        }),
      seed: { live: false },
      succeeds: submissionTransitions.reject.from.filter(status => status !== 'paid_pending_review')
    })
    expect(() =>
      buildRejectSubmissionPlans({
        category: 'other',
        now: NOW,
        reason: '',
        reviewer: 'r',
        submissionId
      })
    ).toThrow(/reason/u)
  })

  it('rejects a live submission by unpublishing it and revoking ownership', () => {
    const plans = () =>
      buildRejectSubmissionPlans({
        category: 'other',
        live: { listingId: liveListingId, publication: publication('rejected-live') },
        now: NOW,
        reason: 'Misleading claims.',
        reviewer: 'reviewer',
        submissionId
      })
    expectTransition({
      after: db => {
        expect(submission(db)).toMatchObject({ rejection_category: 'other', status: 'rejected' })
        expect(listing(db)).toMatchObject({ is_active: 0, status: 'approved' })
        expect(events(db, 'unpublished')).toBe(1)
        expect(publicationState(db).version).toBe(2)
      },
      event: 'rejected',
      plans,
      seed: { live: true, paid: true },
      succeeds: submissionTransitions.reject.from
    })
    const db = database('paid_pending_review')
    execute(db, recordOwnerPlans())
    execute(db, plans())
    expect(db.prepare('SELECT revoked_reason FROM listing_owners').all()).toEqual([
      { revoked_reason: 'submission_rejected' }
    ])

    // Already taken down outside the plans: the rejection succeeds and records no unpublish.
    const down = database('changes_requested', { live: true, paid: true })
    down.prepare('UPDATE listings SET is_active=0 WHERE id=?').run(liveListingId)
    execute(down, plans())
    expect(submission(down).status).toBe('rejected')
    expect(events(down, 'unpublished')).toBe(0)
  })

  it('blocks a prohibited registrable domain and its subdomains until an admin lifts it', () => {
    const db = database('verified')
    execute(
      db,
      buildRejectSubmissionPlans({
        category: 'prohibited',
        now: NOW,
        reason: 'Malware distribution.',
        reviewer: 'reviewer',
        submissionId
      })
    )
    expect(
      db
        .prepare(
          'SELECT url_key,covers_subdomains,submission_id,lifted_at FROM listing_submission_url_blocks'
        )
        .all()
    ).toEqual([
      { covers_subdomains: 1, lifted_at: null, submission_id: submissionId, url_key: 'example.com' }
    ])
    const submit = (slug: string, blockKey: string | null) => () =>
      db
        .prepare(
          `INSERT INTO listing_submissions (id,slug,block_key,block_covers_subdomains,name,
            description,website,content,category_slug,logo_url)
          VALUES (?,?,?,?,'Again','d','https://example.com/','c','tools','https://example.com/logo.png')`
        )
        .run(crypto.randomUUID(), slug, blockKey, blockKey === null ? null : 1)
    const blocked = /blocked until an admin lifts the block/u
    expect(submit('example.com', 'example.com')).toThrow(blocked)
    expect(submit('go.example.com', 'example.com')).toThrow(blocked)
    // A row without a block key (a pre-#62 Worker) is still caught by the subdomain match.
    expect(submit('www2.example.com', null)).toThrow(blocked)
    expect(submit('notexample.com', 'notexample.com')).not.toThrow()

    execute(
      db,
      buildLiftSubmissionUrlBlockPlans({
        admin: 'admin',
        note: 'Appealed.',
        now: NOW,
        urlKey: 'example.com'
      })
    )
    expect(() =>
      execute(
        db,
        buildLiftSubmissionUrlBlockPlans({
          admin: 'admin',
          note: '',
          now: NOW,
          urlKey: 'example.com'
        })
      )
    ).toThrow(/malformed JSON/u)
    expect(submit('go.example.com', 'example.com')).not.toThrow()
  })

  it('blocks only the exact host for a public suffix, an IP, or a pre-#62 row', () => {
    for (const [slug, blockKey, covers] of [
      ['github.io', 'github.io', 0],
      ['go.legacy.example', null, null]
    ] as const) {
      const db = database('verified')
      db.prepare(
        'UPDATE listing_submissions SET slug=?, block_key=?, block_covers_subdomains=? WHERE id=?'
      ).run(slug, blockKey, covers, submissionId)
      execute(
        db,
        buildRejectSubmissionPlans({
          category: 'prohibited',
          now: NOW,
          reason: 'Prohibited.',
          reviewer: 'reviewer',
          submissionId
        })
      )
      expect(
        db.prepare('SELECT url_key,covers_subdomains FROM listing_submission_url_blocks').get()
      ).toEqual({ covers_subdomains: 0, url_key: slug })
      const submit = (host: string) => () =>
        db
          .prepare(
            `INSERT INTO listing_submissions (id,slug,name,description,website,content,
              category_slug,logo_url) VALUES (?,?,'Again','d','https://example.com/','c','tools','l')`
          )
          .run(crypto.randomUUID(), host)
      expect(submit(slug)).toThrow(/blocked until an admin lifts the block/u)
      // Separate sites under a public suffix stay open; for a pre-#62 row this is the documented
      // limitation (staging only: production had no submissions before #62).
      expect(submit(`unrelated.${slug}`)).not.toThrow()
    }
    expect(() =>
      database('verified')
        .prepare('UPDATE listing_submissions SET block_covers_subdomains=0 WHERE id=?')
        .run(submissionId)
    ).not.toThrow()
  })

  it('widens an active exact-host block when a later rejection covers subdomains', () => {
    // Both queued at once: a pre-#62 row on the bare domain (no block key, so its block covers
    // the exact host only) and a native row on a subdomain keyed on the same registrable domain.
    function queued(): { db: DatabaseSync; legacy: string; native: string } {
      const db = planDatabase()
      const legacy = crypto.randomUUID()
      const native = crypto.randomUUID()
      db.prepare(
        `INSERT INTO listing_submissions (id,slug,name,description,website,content,category_slug,
          logo_url,status,plan)
        VALUES (?,'casino3.example','Legacy','d','https://casino3.example/','c','tools','l',
          'verified','free')`
      ).run(legacy)
      db.prepare(
        `INSERT INTO listing_submissions (id,slug,block_key,block_covers_subdomains,name,
          description,website,content,category_slug,logo_url,status,plan)
        VALUES (?,'go.casino3.example','casino3.example',1,'Go','d','https://go.casino3.example/',
          'c','tools','l','verified','free')`
      ).run(native)
      return { db, legacy, native }
    }
    const reject = (id: string) =>
      buildRejectSubmissionPlans({
        category: 'prohibited',
        now: NOW,
        reason: 'Prohibited.',
        reviewer: 'reviewer',
        submissionId: id
      })
    const scope = (db: DatabaseSync) =>
      db.prepare('SELECT url_key, covers_subdomains FROM listing_submission_url_blocks').all()
    const submit = (db: DatabaseSync, host: string) => () =>
      db
        .prepare(
          `INSERT INTO listing_submissions (id,slug,block_key,block_covers_subdomains,name,
            description,website,content,category_slug,logo_url,plan)
          VALUES (?,?,'casino3.example',1,'Again','d','https://example.com/','c','tools','l',
            'free')`
        )
        .run(crypto.randomUUID(), host)

    // The reviewer's case: the legacy row is rejected first, then the native one.
    const first = queued()
    execute(first.db, reject(first.legacy))
    expect(scope(first.db)).toEqual([{ covers_subdomains: 0, url_key: 'casino3.example' }])
    expect(submit(first.db, 'shop.casino3.example')).not.toThrow()
    execute(first.db, reject(first.native))
    expect(scope(first.db)).toEqual([{ covers_subdomains: 1, url_key: 'casino3.example' }])
    expect(submit(first.db, 'www2.casino3.example')).toThrow(
      /blocked until an admin lifts the block/u
    )

    // The other order: an exact-host rejection never narrows a subdomain-covering block.
    const second = queued()
    execute(second.db, reject(second.native))
    execute(second.db, reject(second.legacy))
    expect(scope(second.db)).toEqual([{ covers_subdomains: 1, url_key: 'casino3.example' }])
  })

  it('lets an other-category rejection be resubmitted as a new submission', () => {
    const db = database('verified')
    execute(
      db,
      buildRejectSubmissionPlans({
        category: 'other',
        now: NOW,
        reason: 'Logo missing.',
        reviewer: 'reviewer',
        submissionId
      })
    )
    expect(() =>
      db
        .prepare(
          `INSERT INTO listing_submissions (id,slug,name,description,website,content,category_slug,
            logo_url) VALUES (?,'example.com','Again','d','https://example.com/','c','tools','l')`
        )
        .run(crypto.randomUUID())
    ).not.toThrow()
  })

  it('lets the owner edit only outside the review queue, and bumps the content version', () => {
    const ownerEdit = () =>
      buildReplaceSubmissionContentPlans({
        actor: 'user_owner',
        content,
        expectedStatuses: submissionTransitions.ownerEdit.from,
        now: NOW,
        ownerUserId: 'user_owner',
        submissionId
      })
    expectTransition({
      after: (db, from) => {
        expect(submission(db)).toMatchObject({
          category_slug: 'apps',
          content_version: 2,
          name: 'New name',
          status: from
        })
        expect(
          db
            .prepare('SELECT label FROM listing_submission_resource_links ORDER BY sort_order')
            .all()
        ).toEqual([{ label: 'Pricing' }, { label: 'Docs' }])
      },
      event: 'edited',
      plans: ownerEdit,
      succeeds: submissionTransitions.ownerEdit.from
    })
    expect(() =>
      buildReplaceSubmissionContentPlans({
        actor: 'user_owner',
        content,
        expectedStatuses: ['verified'],
        now: NOW,
        ownerUserId: 'user_owner',
        submissionId
      })
    ).toThrow(/only as a draft/u)
  })

  it('lets a reviewer edit any queued submission, refusing a stale version', () => {
    const reviewerEdit = (expectedContentVersion?: number) =>
      buildReplaceSubmissionContentPlans({
        actor: 'reviewer',
        content,
        expectedContentVersion,
        expectedStatuses: submissionTransitions.edit.from,
        now: NOW,
        submissionId
      })
    expectTransition({
      after: (db, from) =>
        expect(submission(db)).toMatchObject({
          content_version: 2,
          name: 'New name',
          status: from
        }),
      event: 'edited',
      plans: () => reviewerEdit(),
      succeeds: submissionTransitions.edit.from
    })
    const db = database('paid_pending_review')
    execute(db, reviewerEdit(1))
    expect(() => execute(db, reviewerEdit(1))).toThrow(/malformed JSON/u)
    expect(() =>
      buildReplaceSubmissionContentPlans({
        actor: 'a',
        content,
        expectedStatuses: ['approved'],
        now: NOW,
        submissionId
      })
    ).toThrow(/before a final decision/u)
  })
})

describe('the owner’s account actions (#65)', () => {
  it('replaces only FAQs and links while the submission waits for review, for its owner', () => {
    const plans = (expectedContentVersion = 1, ownerUserId = 'user_owner') =>
      buildReplaceSubmissionExtrasPlans({
        content: { faqs: [{ answer: 'A2', question: 'Q2' }], resourceLinks: [] },
        expectedContentVersion,
        now: NOW,
        ownerUserId,
        submissionId
      })
    expectTransition({
      after: (db, from) => {
        expect(submission(db)).toMatchObject({
          content_version: 2,
          description: 'Description',
          name: 'Example',
          status: from
        })
        expect(db.prepare('SELECT question FROM listing_submission_faqs').all()).toEqual([
          { question: 'Q2' }
        ])
        expect(count(db, 'SELECT COUNT(*) AS count FROM listing_submission_resource_links')).toBe(0)
      },
      event: 'edited',
      plans: () => plans(),
      succeeds: submissionTransitions.ownerExtras.from
    })
    expect(() => execute(database('verified'), plans(2))).toThrow(/malformed JSON/u)
    expect(() => execute(database('verified'), plans(1, 'user_other'))).toThrow(/malformed JSON/u)
  })

  function ownedLiveListing(db: DatabaseSync, owner = 'user_owner'): void {
    db.prepare(
      `INSERT INTO listing_owners (listing_id,user_id,role,verified_via,verified_at)
      VALUES (?,?,'owner','submission','2026-08-01T00:00:00.000Z')`
    ).run(liveListingId, owner)
  }

  const claim = (options: Partial<ListingBadgeCheckClaim> = {}) =>
    buildClaimListingBadgeCheckPlans({
      claimedAt: '2026-10-06 12:00:00',
      conclusiveCodes: ['badge_missing', 'link_not_followed'],
      cooldownCutoff: '2026-10-06 11:59:30',
      maxChecks: 10,
      now: NOW,
      ownerUserId: 'user_owner',
      submissionId,
      windowStart: '2026-10-05 12:00:00',
      ...options
    })

  /** A panel check's event at `at` (`YYYY-MM-DD HH:MM:SS`). */
  function panelCheck(db: DatabaseSync, at: string, eventType: string, detail: string | null) {
    db.prepare(
      `INSERT INTO listing_submission_events (submission_id,event_type,detail,actor,created_at)
      VALUES (?,?,?,?,?)`
    ).run(submissionId, eventType, detail, LISTING_BADGE_CHECK_ACTOR, at)
  }

  it('claims a badge check only for the owner’s live, free, approved listing', () => {
    for (const status of submissionStatuses) {
      const db = database(status, { live: true })
      if (listing(db)) ownedLiveListing(db)
      const before = submission(db)
      if ((submissionTransitions.listingBadgeCheck.from as readonly string[]).includes(status)) {
        execute(db, claim())
        expect(submission(db)).toMatchObject({
          last_verification_at: '2026-10-06 12:00:00',
          status
        })
      } else {
        expect(() => execute(db, claim()), `${status} must be refused`).toThrow(/malformed JSON/u)
        expect(submission(db)).toEqual(before)
      }
      db.close()
    }
    const tenToday = (db: DatabaseSync) => {
      for (let index = 0; index < 10; index += 1) {
        panelCheck(db, `2026-10-06 0${index}:00:00`, 'badge_verified', null)
      }
    }
    const refusals: Array<[string, (db: DatabaseSync) => void]> = [
      ['paid', db => db.prepare("UPDATE listing_submissions SET plan='paid', paid_at=?").run(NOW)],
      ['down', db => db.prepare('UPDATE listings SET is_active=0').run()],
      [
        'revoked',
        db => db.prepare("UPDATE listing_owners SET revoked_at=?, revoked_reason='x'").run(NOW)
      ],
      [
        'cooling down',
        db =>
          db
            .prepare("UPDATE listing_submissions SET last_verification_at='2026-10-06 11:59:50'")
            .run()
      ],
      ['ten checks in the last 24 hours', tenToday]
    ]
    for (const [label, change] of refusals) {
      const db = database('approved')
      ownedLiveListing(db)
      change(db)
      expect(() => execute(db, claim()), label).toThrow(/malformed JSON/u)
      db.close()
    }
    const allowed: Array<[string, (db: DatabaseSync) => void]> = [
      // The badge step's own lifetime cap (#84) doesn't lock the panel.
      [
        'badge step used its ten',
        db =>
          db
            .prepare(
              "UPDATE listing_submissions SET verification_attempts=10, last_verification_error='badge_missing'"
            )
            .run()
      ],
      // Connection problems, and checks older than the window, don't count.
      [
        'nine results and a timeout',
        db => {
          for (let index = 0; index < 9; index += 1) {
            panelCheck(db, `2026-10-06 0${index}:00:00`, 'verification_failed', 'badge_missing')
          }
          panelCheck(db, '2026-10-06 10:00:00', 'verification_failed', 'fetch_timeout')
        }
      ],
      [
        'ten yesterday',
        db => {
          for (let index = 0; index < 10; index += 1) {
            panelCheck(db, `2026-10-05 0${index}:00:00`, 'badge_verified', null)
          }
        }
      ]
    ]
    for (const [label, change] of allowed) {
      const db = database('approved')
      ownedLiveListing(db)
      change(db)
      expect(() => execute(db, claim()), label).not.toThrow()
      db.close()
    }
    expect(() => execute(database('approved'), claim({ ownerUserId: 'user_other' }))).toThrow(
      /malformed JSON/u
    )
  })

  it('records a claimed check once, as a panel event, leaving the badge step’s counter alone', () => {
    const db = database('approved')
    ownedLiveListing(db)
    execute(db, claim())
    const finish = (
      result: { ok: true } | { code: string; ok: false },
      claimedAt = '2026-10-06 12:00:00'
    ) =>
      buildFinishListingBadgeCheckPlans({
        claimedAt,
        now: NOW,
        ownerUserId: 'user_owner',
        result,
        submissionId
      })
    expect(() => execute(db, finish({ ok: true }, '2026-10-06 11:00:00'))).toThrow(
      /malformed JSON/u
    )
    execute(db, finish({ code: 'link_not_followed', ok: false }))
    execute(db, finish({ ok: true }))
    expect(submission(db)).toMatchObject({
      last_verification_error: null,
      status: 'approved',
      verification_attempts: 0
    })
    expect(
      db
        .prepare(
          'SELECT event_type,detail,actor,created_at FROM listing_submission_events ORDER BY id'
        )
        .all()
    ).toEqual([
      {
        actor: LISTING_BADGE_CHECK_ACTOR,
        created_at: '2026-10-06 12:00:00',
        detail: 'link_not_followed',
        event_type: 'verification_failed'
      },
      {
        actor: LISTING_BADGE_CHECK_ACTOR,
        created_at: '2026-10-06 12:00:00',
        detail: null,
        event_type: 'badge_verified'
      }
    ])
    expect(count(db, 'SELECT COUNT(*) AS count FROM badge_checks')).toBe(0)
  })
})

describe('refunds keep the plan model consistent (paid → free)', () => {
  /** A badge check of the live listing; returns its id. */
  function badgeCheck(
    db: DatabaseSync,
    outcome: 'fail' | 'pass',
    conclusive: boolean,
    at: string,
    kind: 'confirmation' | 'refund' | 'weekly' = 'weekly'
  ): number {
    return Number(
      db
        .prepare(
          `INSERT INTO badge_checks (listing_id,checked_at,outcome,reason,conclusive,kind)
          VALUES (?,?,?,?,?,?)`
        )
        .run(
          liveListingId,
          at,
          outcome,
          outcome === 'pass' ? null : conclusive ? 'badge_missing' : 'fetch_timeout',
          conclusive ? 1 : 0,
          kind
        ).lastInsertRowid
    )
  }
  /** Earlier than `NOW`: a recent weekly check, and the refund's own check (minutes before). */
  const RECENT = '2026-10-01T00:00:00.000Z'
  const AT_REFUND = '2026-10-06T11:55:00.000Z'
  const STALE_REFUND = '2026-10-06T10:00:00.000Z'

  it('refunds only an other-category rejection, once', () => {
    const db = database('rejected', { paid: true })
    const plans = () =>
      buildRefundSubmissionPlans({
        actor: 'admin',
        mode: 'after_rejection',
        now: NOW,
        submissionId
      })
    const pending = (target: DatabaseSync) =>
      (query(target, selectRefundPendingSubmissionsPlan(10)) as Array<{ id: string }>).map(
        row => row.id
      )
    // The rejection marks the refund pending until it is recorded (#64 review).
    expect(pending(db)).toEqual([submissionId])
    execute(db, plans())
    expect(submission(db)).toMatchObject({ plan: 'paid', refunded_at: NOW, status: 'rejected' })
    expect(events(db, 'refunded')).toBe(1)
    expect(pending(db)).toEqual([])
    expect(() => execute(db, plans())).toThrow(/malformed JSON/u)
    expect(events(db, 'refunded')).toBe(1)

    const prohibited = database('rejected', { paid: true })
    prohibited
      .prepare("UPDATE listing_submissions SET rejection_category='prohibited' WHERE id=?")
      .run(submissionId)
    expect(pending(prohibited)).toEqual([])
    expect(() => execute(prohibited, plans())).toThrow(/malformed JSON/u)
    expect(submission(prohibited).refunded_at).toBeNull()
    expect(() =>
      prohibited
        .prepare('UPDATE listing_submissions SET refunded_at=? WHERE id=?')
        .run(NOW, submissionId)
    ).toThrow(/listing_submissions_no_refund_when_prohibited/u)

    const queued = database('verified', { paid: true })
    expect(pending(queued)).toEqual([])
    expect(pending(database('rejected', { paid: false }))).toEqual([])
    expect(() => execute(queued, plans())).toThrow(/malformed JSON/u)
    expect(submission(queued)).toMatchObject({ plan: 'paid', refunded_at: null })
  })

  it('keeps a refunded listing live as free only when its refund check passed, and records it', () => {
    const keep = (badgeCheckId: number) =>
      buildRefundSubmissionPlans({
        actor: 'admin',
        badgeCheckId,
        mode: 'keep_free',
        now: NOW,
        submissionId
      })

    const passing = database('approved', { paid: true })
    badgeCheck(passing, 'fail', true, RECENT)
    const refundPass = badgeCheck(passing, 'pass', true, AT_REFUND, 'refund')
    execute(passing, keep(refundPass))
    expect(submission(passing)).toMatchObject({
      plan: 'free',
      refunded_at: NOW,
      status: 'approved'
    })
    expect(listing(passing)).toMatchObject({ is_active: 1 })
    expect(publicationState(passing).version).toBe(1)
    const recorded = passing
      .prepare("SELECT detail FROM listing_submission_events WHERE event_type='refunded'")
      .get() as { detail: string }
    expect(JSON.parse(recorded.detail)).toEqual({
      badge_check_id: refundPass,
      badge_checked_at: AT_REFUND,
      mode: 'kept_as_free'
    })

    // Refused: a recent weekly pass is not the refund check; a refund check that missed, that
    // couldn't tell, that is stale, or that a later refund check replaced.
    const refused: Array<(db: DatabaseSync) => number> = [
      db => badgeCheck(db, 'pass', true, RECENT),
      db => {
        badgeCheck(db, 'pass', true, RECENT)
        return badgeCheck(db, 'fail', false, AT_REFUND, 'refund')
      },
      db => badgeCheck(db, 'fail', true, AT_REFUND, 'refund'),
      db => badgeCheck(db, 'pass', true, STALE_REFUND, 'refund'),
      db => {
        const first = badgeCheck(db, 'pass', true, STALE_REFUND, 'refund')
        badgeCheck(db, 'fail', false, AT_REFUND, 'refund')
        return first
      }
    ]
    for (const [index, seed] of refused.entries()) {
      const db = database('approved', { paid: true })
      const id = seed(db)
      expect(() => execute(db, keep(id)), String(index)).toThrow(/malformed JSON/u)
      expect(submission(db)).toMatchObject({ plan: 'paid', refunded_at: null })
    }
  })

  it('unpublishes a refunded live listing whose refund check missed or could not tell', () => {
    const plans = (badgeCheckId: number) =>
      buildRefundSubmissionPlans({
        actor: 'admin',
        badgeCheckId,
        mode: 'unpublish',
        now: NOW,
        publication: publication('refund-unpublish'),
        submissionId
      })
    // A recent weekly pass doesn't stop it: the refund decides on its own check (#66 round 2).
    for (const [outcome, conclusive] of [
      ['fail', true],
      ['fail', false]
    ] as const) {
      const db = database('approved', { paid: true })
      badgeCheck(db, 'pass', true, RECENT)
      execute(db, plans(badgeCheck(db, outcome, conclusive, AT_REFUND, 'refund')))
      expect(submission(db)).toMatchObject({ plan: 'paid', refunded_at: NOW, status: 'approved' })
      expect(listing(db)).toMatchObject({ is_active: 0, status: 'approved' })
      expect(events(db, 'refunded')).toBe(1)
      expect(events(db, 'unpublished')).toBe(1)
      expect(publicationState(db).version).toBe(2)
    }

    // Refused when the refund check passed (keep it free instead), or is not a refund check.
    for (const seed of [
      (db: DatabaseSync) => badgeCheck(db, 'pass', true, AT_REFUND, 'refund'),
      (db: DatabaseSync) => badgeCheck(db, 'fail', true, AT_REFUND, 'weekly')
    ]) {
      const db = database('approved', { paid: true })
      expect(() => execute(db, plans(seed(db)))).toThrow(/malformed JSON/u)
      expect(listing(db)).toMatchObject({ is_active: 1 })
      expect(publicationState(db).version).toBe(1)
    }
  })

  it('refunds an approved paid listing that is already down, without a publication', () => {
    const plans = () =>
      buildRefundSubmissionPlans({
        actor: 'admin',
        mode: 'already_unpublished',
        now: NOW,
        submissionId
      })
    const live = database('approved', { paid: true })
    expect(() => execute(live, plans())).toThrow(/malformed JSON/u)

    const unpublished = database('approved', { paid: true })
    unpublished.prepare('UPDATE listings SET is_active=0 WHERE id=?').run(liveListingId)
    execute(unpublished, plans())
    expect(submission(unpublished)).toMatchObject({ refunded_at: NOW, status: 'approved' })
    expect(publicationState(unpublished).version).toBe(1)
    expect(() => execute(unpublished, plans())).toThrow(/malformed JSON/u)

    const deleted = database('approved', { paid: true })
    deleted.prepare('DELETE FROM listings WHERE id=?').run(liveListingId)
    expect(submission(deleted).listing_id).toBeNull()
    execute(deleted, plans())
    expect(submission(deleted).refunded_at).toBe(NOW)
  })
})

function recordOwnerPlans(): StatementPlan[] {
  return [
    {
      sql: `INSERT INTO listing_owners (listing_id,user_id,verified_via,verified_at)
        VALUES (?, 'user_owner', 'submission', ?)`,
      params: [liveListingId, NOW]
    }
  ]
}

describe('protected submission statement plans', () => {
  it('reads the decision snapshot from the singleton publication state', () => {
    const db = database('verified')
    expect(query(db, selectSubmissionForDecisionPlan(submissionId))).toEqual([
      {
        block_covers_subdomains: 1,
        block_key: 'example.com',
        checksum: 'before',
        content_version: 1,
        id: submissionId,
        listing_id: null,
        listing_live: 0,
        owner_user_id: 'user_owner',
        paid_at: null,
        plan: 'free',
        published_checksum: null,
        refunded_at: null,
        rejection_category: null,
        slug: 'example.com',
        status: 'verified',
        version: 1
      }
    ])
  })

  it('atomically promotes normalized data', () => {
    const db = database('verified')
    execute(db, approvalPlans())

    expect(db.prepare('SELECT status,source_identity FROM listings').get()).toEqual({
      source_identity: submissionId,
      status: 'approved'
    })
    expect(db.prepare('SELECT status,listing_id FROM listing_submissions').get()).toEqual({
      listing_id: liveListingId,
      status: 'approved'
    })
    expect(db.prepare('SELECT version FROM publication_state').get()).toEqual({ version: 2 })
    expect(
      db.prepare('SELECT outcome,affected_routes,workflow FROM publication_runs').get()
    ).toEqual({
      affected_routes: '/products/example.com/',
      outcome: 'succeeded',
      workflow: 'app/admin'
    })
    expect(events(db, 'approved')).toBe(1)
  })

  it('approves an ownerless pre-#63 submission without creating an owner', () => {
    const db = database('verified', { owner: null })
    execute(db, approvalPlans())
    expect(count(db, 'SELECT COUNT(*) AS count FROM listing_owners')).toBe(0)
  })

  it('rolls back every approval side effect when publication state becomes stale', () => {
    const db = database('verified')
    db.prepare("UPDATE publication_state SET version=2,checksum='concurrent'").run()

    expect(() => execute(db, approvalPlans())).toThrow(/malformed JSON/u)
    expect(db.prepare('SELECT COUNT(*) AS count FROM listings').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM publication_runs').get()).toEqual({ count: 0 })
    expect(events(db, 'approved')).toBe(0)
    expect(db.prepare('SELECT status,listing_id FROM listing_submissions').get()).toEqual({
      listing_id: null,
      status: 'verified'
    })
    expect(db.prepare('SELECT version,checksum FROM publication_state').get()).toEqual({
      checksum: 'concurrent',
      version: 2
    })
  })

  it('rolls back a rejection event when a concurrent decision wins', () => {
    const db = database('verified')
    const plans = buildRejectSubmissionPlans({
      category: 'prohibited',
      now: '2026-08-01T01:00:00.000Z',
      reason: 'Spam',
      reviewer: 'reviewer',
      submissionId
    })
    db.prepare("UPDATE listing_submissions SET status='approved' WHERE id=?").run(submissionId)

    expect(() => execute(db, plans)).toThrow(/malformed JSON/u)
    expect(db.prepare('SELECT status,reviewed_by FROM listing_submissions').get()).toEqual({
      reviewed_by: null,
      status: 'approved'
    })
    expect(events(db, 'rejected')).toBe(0)
    expect(count(db, 'SELECT COUNT(*) AS count FROM listing_submission_url_blocks')).toBe(0)
  })

  it('guards decision mutations with single-row assertions and no Site scoping', () => {
    const approvalSql = approvalPlans()
      .map(plan => plan.sql)
      .join('\n')
    const rejectionSql = buildRejectSubmissionPlans({
      category: 'other',
      now: NOW,
      reason: 'x',
      reviewer: 'r',
      submissionId
    })
      .map(plan => plan.sql)
      .join('\n')
    expect(approvalSql).not.toContain('site_id')
    expect(rejectionSql).not.toContain('site_id')
    expect(approvalSql).not.toMatch(/\bTEMP\b/iu)
    expect(rejectionSql).not.toMatch(/\bTEMP\b/iu)
    expect(approvalSql).toContain("json_extract('', '$')")
    expect(rejectionSql).toContain("json_extract('', '$')")
  })
})

describe('tags and the stale-slug resolver at approval and payment (#341, design 4.4)', () => {
  /** The fixture in `status`, with the taxonomy, its category and suggested tags as given. */
  function staged(
    status: SubmissionStatus,
    options: SeedOptions & { category?: string; tags?: string[] | null } = {}
  ): DatabaseSync {
    const db = planDatabase()
    seedTags(db)
    seedSubmission(db, status, options)
    db.prepare('UPDATE listing_submissions SET category_slug=?,tag_slugs=? WHERE id=?').run(
      options.category ?? 'tools',
      options.tags === undefined || options.tags === null ? null : JSON.stringify(options.tags),
      submissionId
    )
    return db
  }

  const pay = () =>
    buildRecordSubmissionPaymentPlans({
      actor: 'stripe',
      listingId: liveListingId,
      now: NOW,
      outcome: 'publish',
      publication: publication('paid-listing'),
      submissionId
    })

  /** Sets the live listing's tags in order, as an admin's edit or a manifest would. */
  function tagListing(db: DatabaseSync, slugs: string[]): void {
    db.prepare('DELETE FROM listing_tags WHERE listing_id=?').run(liveListingId)
    slugs.forEach((slug, order) => {
      db.prepare(
        'INSERT INTO listing_tags (listing_id,tag_id,sort_order) SELECT ?,id,? FROM tags WHERE slug=?'
      ).run(liveListingId, order, slug)
    })
  }

  it('approval tags the listing with the active suggested tags, numbered from 0', () => {
    const db = staged('verified', {
      live: false,
      tags: ['whiteboards', 'retired-tag', 'note-taking']
    })
    execute(db, approvalPlans())
    expect(primaryCategory(db, liveListingId)).toBe('tools')
    // A retired or unknown tag is dropped; the rest keep the Creator's order, from 0, as the
    // admin edit and the publisher number them (best pages rank by it).
    expect(listingTagOrder(db, liveListingId)).toEqual([
      { slug: 'whiteboards', sort_order: 0 },
      { slug: 'note-taking', sort_order: 1 }
    ])
    const unknown = staged('verified', { live: false, tags: ['no-such-tag', 'note-taking'] })
    execute(unknown, approvalPlans())
    expect(listingTagOrder(unknown, liveListingId)).toEqual([
      { slug: 'note-taking', sort_order: 0 }
    ])
  })

  it('approval of a submission without suggested tags leaves the listing untagged', () => {
    const db = staged('verified', { live: false, tags: null })
    execute(db, approvalPlans())
    expect(listingTagOrder(db, liveListingId)).toEqual([])
  })

  it('a paid draft naming a retired narrow slug goes live at payment under its hub and tag', () => {
    const db = staged('draft', {
      category: 'chatbots',
      draftPlan: 'paid',
      live: false,
      tags: ['note-taking', 'chatbots']
    })
    execute(db, pay())
    expect(submission(db)).toMatchObject({
      listing_id: liveListingId,
      status: 'paid_pending_review'
    })
    expect(listing(db)).toMatchObject({ is_active: 1, status: 'approved' })
    // The retired `chatbots` category resolves to the hub of the active `chatbots` tag (Apps).
    // That tag comes first; a suggested duplicate of it is kept once.
    expect(primaryCategory(db, liveListingId)).toBe('apps')
    expect(listingTagOrder(db, liveListingId)).toEqual([
      { slug: 'chatbots', sort_order: 0 },
      { slug: 'note-taking', sort_order: 1 }
    ])
    expect(publicationState(db).version).toBe(2)
  })

  it('a paid draft naming a merged narrow slug goes live through its taxonomy redirect', () => {
    // `merged-narrow` became the tag `note-taking` (Tools), as `ai-copywriting-free` became
    // `ai-copywriting`; `best-narrow` redirects to a best page on `whiteboards` (Apps); and
    // `hub-narrow` to the category Apps, with no tag.
    for (const [category, hub, tags] of [
      ['merged-narrow', 'tools', ['note-taking', 'whiteboards']],
      ['best-narrow', 'apps', ['whiteboards']],
      ['hub-narrow', 'apps', ['whiteboards']]
    ] as const) {
      const db = staged('draft', {
        category,
        draftPlan: 'paid',
        live: false,
        tags: ['whiteboards']
      })
      execute(db, pay())
      expect(submission(db).status, category).toBe('paid_pending_review')
      expect(primaryCategory(db, liveListingId), category).toBe(hub)
      expect(listingTagOrder(db, liveListingId), category).toEqual(
        tags.map((slug, order) => ({ slug, sort_order: order }))
      )
    }
  })

  it('a verified submission naming a retired narrow slug is approved under its hub and tag', () => {
    const db = staged('verified', { category: 'chatbots', live: false, tags: null })
    execute(db, approvalPlans())
    expect(primaryCategory(db, liveListingId)).toBe('apps')
    expect(listingTagOrder(db, liveListingId)).toEqual([{ slug: 'chatbots', sort_order: 0 }])
  })

  it('refuses a slug that is neither a category, a tag, nor redirected, at payment too', () => {
    for (const category of ['retired-tag', 'no-such-slug']) {
      const db = staged('draft', { category, draftPlan: 'paid', live: false })
      expect(() => execute(db, pay())).toThrow(/malformed JSON/u)
      expect(count(db, 'SELECT COUNT(*) AS count FROM listings')).toBe(0)
      expect(submission(db).status).toBe('draft')
    }
  })

  it("a live approval leaves the listing's tags, so an admin's edit during review stands", () => {
    // Payment gave the listing the submission's tags; an admin then changed them (design 4.3).
    for (const [category, tags, edited] of [
      // The submission named tags: approval doesn't put them back.
      ['tools', ['whiteboards', 'note-taking'], ['note-taking']],
      // It named none.
      ['tools', null, ['whiteboards']],
      // A retired narrow slug: approval doesn't re-add the resolver tag the admin removed.
      ['chatbots', null, ['whiteboards']],
      ['chatbots', ['chatbots', 'note-taking'], ['note-taking']]
    ] as const) {
      const db = staged('paid_pending_review', { category, tags: tags ? [...tags] : null })
      tagListing(db, [...edited])
      execute(db, approveLivePlans())
      expect(submission(db).status).toBe('approved')
      expect(listingTagOrder(db, liveListingId), `${category} ${tags}`).toEqual(
        edited.map((slug, order) => ({ slug, sort_order: order }))
      )
    }
    // The primary category still follows the resolver: the retired slug files under its hub.
    const db = staged('paid_pending_review', { category: 'chatbots', tags: null })
    execute(db, approveLivePlans())
    expect(primaryCategory(db, liveListingId)).toBe('apps')
  })

  it('a content edit writes the suggested tags when given and keeps them otherwise', () => {
    const db = staged('verified', { live: false, tags: ['note-taking'] })
    const edit = (tagSlugs: string[] | null | undefined, version: number) =>
      execute(
        db,
        buildReplaceSubmissionContentPlans({
          actor: 'reviewer',
          content: { ...content, tagSlugs },
          expectedContentVersion: version,
          expectedStatuses: ['verified'],
          now: NOW,
          submissionId
        })
      )
    edit(undefined, 1)
    expect(submission(db).tag_slugs).toBe('["note-taking"]')
    edit(['whiteboards', 'note-taking'], 2)
    expect(submission(db).tag_slugs).toBe('["whiteboards","note-taking"]')
    edit([], 3)
    expect(submission(db).tag_slugs).toBe('[]')
    edit(null, 4)
    expect(submission(db).tag_slugs).toBeNull()
    expect(() => edit(['a', 'b', 'c', 'd'], 5)).toThrow(/at most 3/u)
    expect(() => edit(['a', 'a'], 5)).toThrow(/distinct/u)
  })
})

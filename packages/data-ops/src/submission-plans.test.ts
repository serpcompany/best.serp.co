import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import type { StatementPlan } from './plan-support'
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
import { type SubmissionStatus, submissionStatuses } from './schema'
import {
  buildApproveLiveSubmissionPlans,
  buildApproveSubmissionPlans,
  buildChooseSubmissionPlanPlans,
  buildLiftSubmissionUrlBlockPlans,
  buildRecordSubmissionPaymentPlans,
  buildRefundSubmissionPlans,
  buildRejectSubmissionPlans,
  buildReplaceSubmissionContentPlans,
  buildRequestSubmissionChangesPlans,
  buildResubmitSubmissionPlans,
  buildWithdrawSubmissionPlans,
  recordSubmissionNotificationPlan,
  selectSubmissionForDecisionPlan,
  selectVerifiedSubmissionNotificationPlans,
  submissionTransitions
} from './submission-plans'

const submissionId = '11111111-1111-4111-8111-111111111111'
const liveListingId = `submission_${submissionId}`

interface SeedOptions {
  /** The plan a draft has chosen so far (default: none). */
  draftPlan?: 'free' | 'paid' | null
  live?: boolean
  owner?: string | null
  paid?: boolean
}

/**
 * Inserts the fixture submission in `status`, satisfying the table's CHECK constraints:
 * `paid_pending_review` is always live and paid, `approved` is live, `rejected` carries a
 * category, a `draft` is never paid or live and `pending_badge` never paid. Other statuses are
 * free, unpaid, and not live unless asked.
 */
function seedSubmission(
  db: DatabaseSync,
  status: SubmissionStatus,
  options: SeedOptions = {}
): void {
  const live =
    status === 'paid_pending_review' ||
    (status !== 'draft' && (options.live ?? status === 'approved'))
  const paid =
    status === 'paid_pending_review' ||
    (status !== 'draft' && status !== 'pending_badge' && (options.paid ?? false))
  const plan = status === 'draft' ? (options.draftPlan ?? null) : paid ? 'paid' : 'free'
  if (live) {
    seedLiveListing(db, liveListingId, { slug: 'example.com' })
    db.prepare(
      "UPDATE listings SET source='submission', link_rel='nofollow', source_kind='verified-submission', source_identity=? WHERE id=?"
    ).run(submissionId, liveListingId)
  }
  db.prepare(
    `INSERT INTO listing_submissions
      (id,slug,name,description,website,content,category_slug,logo_url,status,
       access_token_hash,badge_verified_at,listing_id,owner_user_id,plan,paid_at,
       rejection_reason,rejection_category)
    VALUES (?,'example.com','Example','Description','https://example.com/','Content','tools',
      'https://example.com/logo.png',?,'hash','2026-08-01T00:00:00.000Z',?,?,?,?,?,?)`
  ).run(
    submissionId,
    status,
    live ? liveListingId : null,
    options.owner === undefined ? 'user_owner' : options.owner,
    plan,
    paid ? '2026-08-01T00:00:00.000Z' : null,
    status === 'rejected' ? 'Spam' : null,
    status === 'rejected' ? 'other' : null
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

function approvalPlans() {
  const afterChecksum = createHash('sha256').update('after').digest('hex')
  return buildApproveSubmissionPlans({
    afterChecksum,
    affectedRoute: '/products/example.com/',
    beforeChecksum: 'before',
    listingId: liveListingId,
    manifestId: `verified-submission-${submissionId}`,
    now: '2026-08-01T01:00:00.000Z',
    reviewer: 'reviewer',
    runId: `submission_publish_${submissionId}`,
    submissionId,
    version: 1
  })
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
      expect(events(db, spec.event), `${status}: ${spec.event} event`).toBe(1)
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
  it('names only real statuses, and every decision leaves the review queue', () => {
    for (const [action, transition] of Object.entries(submissionTransitions)) {
      for (const from of transition.from) expect(submissionStatuses, action).toContain(from)
    }
    for (const terminal of ['approved', 'rejected', 'withdrawn'] as const) {
      const outgoing = Object.entries(submissionTransitions).filter(
        ([action, transition]) =>
          action !== 'refund' && (transition.from as readonly string[]).includes(terminal)
      )
      expect(outgoing, `${terminal} is final for review`).toEqual([])
    }
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

  it('records a paid submission as live and queued, or held for review', () => {
    expectTransition({
      after: db => {
        expect(submission(db)).toMatchObject({
          listing_id: liveListingId,
          paid_at: NOW,
          plan: 'paid',
          status: 'paid_pending_review'
        })
        expect(listing(db)).toMatchObject({
          is_active: 1,
          link_rel: 'nofollow',
          status: 'approved'
        })
        expect(count(db, 'SELECT COUNT(*) AS count FROM listing_owners')).toBe(1)
        expect(publicationState(db).version).toBe(2)
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

  it('records a payment once, and only for a draft that chose the paid plan', () => {
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

    for (const draftPlan of [null, 'free'] as const) {
      const unchosen = database('draft', { draftPlan })
      expect(() => execute(unchosen, hold())).toThrow(/malformed JSON/u)
      expect(submission(unchosen)).toMatchObject({
        paid_at: null,
        plan: draftPlan,
        status: 'draft'
      })
    }
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
    // A paid draft may still switch to free before paying; nobody else may choose for it.
    const db = database('draft', { draftPlan: 'paid' })
    expect(() => execute(db, choose('free', 'user_other'))).toThrow(/malformed JSON/u)
    execute(db, choose('free'))
    expect(submission(db)).toMatchObject({ plan: 'free', status: 'pending_badge' })
  })

  it('keeps drafts out of the review queue while they hold the URL against duplicates', () => {
    const db = database('draft')
    expect(query(db, selectVerifiedSubmissionNotificationPlans(10)[0] as StatementPlan)).toEqual([])
    expect(() =>
      db
        .prepare(
          `INSERT INTO listing_submissions (id,slug,name,description,website,content,category_slug,
            logo_url) VALUES (?,'example.com','Again','d','https://example.com/','c','tools','l')`
        )
        .run(crypto.randomUUID())
    ).toThrow(/UNIQUE constraint failed: listing_submissions.slug/u)
    execute(db, buildWithdrawSubmissionPlans({ now: NOW, ownerUserId: 'user_owner', submissionId }))
    expect(submission(db).status).toBe('withdrawn')
  })

  it('approves a live paid submission by applying its staged content', () => {
    expectTransition({
      after: db => {
        expect(submission(db)).toMatchObject({ reviewed_by: 'reviewer', status: 'approved' })
        expect(listing(db)).toMatchObject({ is_active: 1, name: 'Example', status: 'approved' })
        expect(publicationState(db).version).toBe(2)
      },
      event: 'approved',
      plans: () =>
        buildApproveLiveSubmissionPlans({
          listingId: liveListingId,
          now: NOW,
          publication: publication('live-submission-approval'),
          reviewer: 'reviewer',
          submissionId
        }),
      seed: { live: true, paid: true },
      succeeds: submissionTransitions.approveLive.from
    })
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

  it('resubmits back to the queue it left, for the owner only', () => {
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

    const stranger = database('changes_requested')
    expect(() =>
      execute(
        stranger,
        buildResubmitSubmissionPlans({ now: NOW, ownerUserId: 'user_other', submissionId })
      )
    ).toThrow(/malformed JSON/u)
  })

  it('withdraws an unpaid, unpublished submission for its owner', () => {
    expectTransition({
      after: db => expect(submission(db).status).toBe('withdrawn'),
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
  })

  it('blocks a prohibited URL from every new submission until an admin lifts it', () => {
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
      db.prepare('SELECT url_key,submission_id,lifted_at FROM listing_submission_url_blocks').all()
    ).toEqual([{ lifted_at: null, submission_id: submissionId, url_key: 'example.com' }])
    const resubmit = () =>
      db
        .prepare(
          `INSERT INTO listing_submissions (id,slug,name,description,website,content,category_slug,
            logo_url,plan,paid_at) VALUES (?,'example.com','Again','d','https://example.com/','c',
            'tools','https://example.com/logo.png',?,?)`
        )
        .run(crypto.randomUUID(), 'free', null)
    expect(resubmit).toThrow(/blocked until an admin lifts the block/u)

    execute(
      db,
      buildLiftSubmissionUrlBlockPlans({
        admin: 'admin',
        note: 'Owner appealed.',
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
    expect(resubmit).not.toThrow()
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

  it('edits staged content before a final decision, replacing links and FAQs', () => {
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
    expectTransition({
      after: (db, from) => {
        expect(submission(db)).toMatchObject({
          category_slug: 'apps',
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
      plans: () =>
        buildReplaceSubmissionContentPlans({
          actor: 'user_owner',
          content,
          expectedStatuses: submissionTransitions.edit.from,
          now: NOW,
          ownerUserId: 'user_owner',
          submissionId
        }),
      succeeds: submissionTransitions.edit.from
    })
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

describe('refunds keep the plan model consistent (paid → free)', () => {
  function badgeCheck(db: DatabaseSync, outcome: 'fail' | 'pass', conclusive: boolean, at: string) {
    db.prepare(
      'INSERT INTO badge_checks (listing_id,checked_at,outcome,reason,conclusive) VALUES (?,?,?,?,?)'
    ).run(
      liveListingId,
      at,
      outcome,
      outcome === 'pass' ? null : 'badge_missing',
      conclusive ? 1 : 0
    )
  }

  it('records the refund of a rejected paid submission once', () => {
    const db = database('rejected', { paid: true })
    const plans = () =>
      buildRefundSubmissionPlans({
        actor: 'admin',
        mode: 'after_rejection',
        now: NOW,
        submissionId
      })
    execute(db, plans())
    expect(submission(db)).toMatchObject({ plan: 'paid', refunded_at: NOW, status: 'rejected' })
    expect(events(db, 'refunded')).toBe(1)
    expect(() => execute(db, plans())).toThrow(/malformed JSON/u)
    expect(events(db, 'refunded')).toBe(1)

    const queued = database('verified', { paid: true })
    expect(() =>
      execute(
        queued,
        buildRefundSubmissionPlans({
          actor: 'admin',
          mode: 'after_rejection',
          now: NOW,
          submissionId
        })
      )
    ).toThrow(/malformed JSON/u)
    expect(submission(queued)).toMatchObject({ plan: 'paid', refunded_at: null })
  })

  it('keeps a refunded listing live as free only while its latest conclusive check passes', () => {
    const keep = () =>
      buildRefundSubmissionPlans({ actor: 'admin', mode: 'keep_free', now: NOW, submissionId })

    const passing = database('approved', { paid: true })
    badgeCheck(passing, 'fail', true, '2026-09-01T00:00:00.000Z')
    badgeCheck(passing, 'pass', true, '2026-09-08T00:00:00.000Z')
    badgeCheck(passing, 'fail', false, '2026-09-15T00:00:00.000Z')
    execute(passing, keep())
    expect(submission(passing)).toMatchObject({
      plan: 'free',
      refunded_at: NOW,
      status: 'approved'
    })
    expect(listing(passing)).toMatchObject({ is_active: 1 })
    expect(publicationState(passing).version).toBe(1)

    const missing = database('approved', { paid: true })
    badgeCheck(missing, 'pass', true, '2026-09-01T00:00:00.000Z')
    badgeCheck(missing, 'fail', true, '2026-09-08T00:00:00.000Z')
    expect(() => execute(missing, keep())).toThrow(/malformed JSON/u)
    expect(submission(missing)).toMatchObject({ plan: 'paid', refunded_at: null })
  })

  it('unpublishes a refunded listing without a passing badge', () => {
    const plans = () =>
      buildRefundSubmissionPlans({
        actor: 'admin',
        mode: 'unpublish',
        now: NOW,
        publication: publication('refund-unpublish'),
        submissionId
      })
    const db = database('approved', { paid: true })
    execute(db, plans())
    expect(submission(db)).toMatchObject({ plan: 'paid', refunded_at: NOW, status: 'approved' })
    expect(listing(db)).toMatchObject({ is_active: 0, status: 'approved' })
    expect(events(db, 'refunded')).toBe(1)
    expect(events(db, 'unpublished')).toBe(1)
    expect(publicationState(db).version).toBe(2)

    const passing = database('approved', { paid: true })
    badgeCheck(passing, 'pass', true, '2026-09-01T00:00:00.000Z')
    expect(() => execute(passing, plans())).toThrow(/malformed JSON/u)
    expect(listing(passing)).toMatchObject({ is_active: 1 })
    expect(publicationState(passing).version).toBe(1)
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
        checksum: 'before',
        id: submissionId,
        listing_id: null,
        listing_live: 0,
        owner_user_id: 'user_owner',
        paid_at: null,
        plan: 'free',
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
      workflow: 'github/approve-d1-submission'
    })
    expect(events(db, 'approved')).toBe(1)
  })

  it('approves a legacy capability submission without creating an owner', () => {
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

  it('records the notification ledger only for verified submissions', () => {
    const db = database('verified')
    const pending = selectVerifiedSubmissionNotificationPlans(10)
    expect(query(db, pending[0] as StatementPlan)).toMatchObject([{ id: submissionId }])

    const notification = {
      externalId: '42',
      externalUrl: 'https://github.com/example/issues/42',
      previewTokenHash: 'a'.repeat(64),
      recipient: 'reviewer',
      submissionId
    }
    execute(db, [recordSubmissionNotificationPlan(notification)])
    execute(db, [recordSubmissionNotificationPlan({ ...notification, externalId: '43' })])
    expect(
      db
        .prepare(
          'SELECT channel,external_id,preview_token_hash FROM listing_submission_notifications'
        )
        .all()
    ).toEqual([{ channel: 'github_issue', external_id: '43', preview_token_hash: 'a'.repeat(64) }])
    expect(query(db, pending[0] as StatementPlan)).toEqual([])

    db.prepare(
      "UPDATE listing_submissions SET status='rejected',rejection_reason='x',rejection_category='other' WHERE id=?"
    ).run(submissionId)
    execute(db, [recordSubmissionNotificationPlan({ ...notification, externalId: '44' })])
    expect(db.prepare('SELECT external_id FROM listing_submission_notifications').all()).toEqual([
      { external_id: '43' }
    ])
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

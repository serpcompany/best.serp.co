import { createHash } from 'node:crypto'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import {
  buildApproveSubmissionPlans,
  buildRejectSubmissionPlans,
  recordSubmissionNotificationPlan,
  type SubmissionStatementPlan,
  selectSubmissionForDecisionPlan,
  selectVerifiedSubmissionNotificationPlans
} from './submission-plans'
import { applyMigrations } from './test-support'

const submissionId = '11111111-1111-4111-8111-111111111111'

function database(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  applyMigrations(db)
  db.prepare(
    `INSERT INTO categories(slug,name,description,sort_order,is_active)
    VALUES ('tools','Tools','Tools',0,1)`
  ).run()
  db.prepare(
    `INSERT INTO publication_state(id,version,checksum,published_at)
    VALUES (1,1,'before','2026-01-01T00:00:00.000Z')`
  ).run()
  db.prepare(
    `INSERT INTO listing_submissions
      (id,slug,name,description,website,content,category_slug,logo_url,status,
       access_token_hash,badge_verified_at)
    VALUES (?,'example.com','Example','Description','https://example.com/','Content','tools',
      'https://example.com/logo.png','verified','hash','2026-08-01T00:00:00.000Z')`
  ).run(submissionId)
  db.prepare(
    `INSERT INTO listing_submission_resource_links(submission_id,label,url,sort_order)
    VALUES (?,'Docs','https://example.com/docs',0)`
  ).run(submissionId)
  db.prepare(
    `INSERT INTO listing_submission_faqs(submission_id,question,answer,sort_order)
    VALUES (?,'Question','Answer',0)`
  ).run(submissionId)
  return db
}

function execute(db: DatabaseSync, plans: SubmissionStatementPlan[]): void {
  db.exec('BEGIN')
  try {
    for (const plan of plans) {
      const statement = db.prepare(plan.sql)
      const params = plan.params as SQLInputValue[]
      if (statement.columns().length > 0) statement.all(...params)
      else statement.run(...params)
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function query(db: DatabaseSync, plan: SubmissionStatementPlan): unknown[] {
  return db.prepare(plan.sql).all(...(plan.params as SQLInputValue[]))
}

function approvalPlans() {
  const afterChecksum = createHash('sha256').update('after').digest('hex')
  return buildApproveSubmissionPlans({
    afterChecksum,
    affectedRoute: '/products/example.com/reviews/',
    beforeChecksum: 'before',
    listingId: `submission_${submissionId}`,
    manifestId: `verified-submission-${submissionId}`,
    now: '2026-08-01T01:00:00.000Z',
    reviewer: 'reviewer',
    runId: `submission_publish_${submissionId}`,
    submissionId,
    version: 1
  })
}

function rejectionPlans() {
  return buildRejectSubmissionPlans({
    now: '2026-08-01T01:00:00.000Z',
    reviewer: 'reviewer',
    submissionId
  })
}

describe('protected submission statement plans', () => {
  it('reads the decision snapshot from the singleton publication state', () => {
    const db = database()
    expect(query(db, selectSubmissionForDecisionPlan(submissionId))).toEqual([
      {
        checksum: 'before',
        id: submissionId,
        listing_id: null,
        slug: 'example.com',
        status: 'verified',
        version: 1
      }
    ])
  })

  it('atomically promotes normalized data', () => {
    const db = database()
    execute(db, approvalPlans())

    expect(db.prepare('SELECT status,source_identity FROM listings').get()).toEqual({
      source_identity: submissionId,
      status: 'approved'
    })
    expect(db.prepare('SELECT status,listing_id FROM listing_submissions').get()).toEqual({
      listing_id: `submission_${submissionId}`,
      status: 'approved'
    })
    expect(db.prepare('SELECT version FROM publication_state').get()).toEqual({ version: 2 })
    expect(db.prepare('SELECT outcome,affected_routes FROM publication_runs').get()).toEqual({
      affected_routes: '/products/example.com/reviews/',
      outcome: 'succeeded'
    })
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM listing_submission_events WHERE event_type='approved'"
        )
        .get()
    ).toEqual({ count: 1 })
  })

  it('rolls back every approval side effect when publication state becomes stale', () => {
    const db = database()
    db.prepare("UPDATE publication_state SET version=2,checksum='concurrent'").run()

    expect(() => execute(db, approvalPlans())).toThrow(/malformed JSON/u)
    expect(db.prepare('SELECT COUNT(*) AS count FROM listings').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM publication_runs').get()).toEqual({ count: 0 })
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM listing_submission_events WHERE event_type='approved'"
        )
        .get()
    ).toEqual({ count: 0 })
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
    const db = database()
    const plans = rejectionPlans()
    db.prepare("UPDATE listing_submissions SET status='approved' WHERE id=?").run(submissionId)

    expect(() => execute(db, plans)).toThrow(/malformed JSON/u)
    expect(db.prepare('SELECT status,reviewed_by FROM listing_submissions').get()).toEqual({
      reviewed_by: null,
      status: 'approved'
    })
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM listing_submission_events WHERE event_type='rejected'"
        )
        .get()
    ).toEqual({ count: 0 })
  })

  it('records the notification ledger only for verified submissions', () => {
    const db = database()
    const pending = selectVerifiedSubmissionNotificationPlans(10)
    expect(query(db, pending[0] as SubmissionStatementPlan)).toMatchObject([{ id: submissionId }])

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
    expect(query(db, pending[0] as SubmissionStatementPlan)).toEqual([])

    db.prepare("UPDATE listing_submissions SET status='rejected' WHERE id=?").run(submissionId)
    execute(db, [recordSubmissionNotificationPlan({ ...notification, externalId: '44' })])
    expect(db.prepare('SELECT external_id FROM listing_submission_notifications').all()).toEqual([
      { external_id: '43' }
    ])
  })

  it('guards decision mutations with single-row assertions and no Site scoping', () => {
    const approvalSql = approvalPlans()
      .map(plan => plan.sql)
      .join('\n')
    const rejectionSql = rejectionPlans()
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

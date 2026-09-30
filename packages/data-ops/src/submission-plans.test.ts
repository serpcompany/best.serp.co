import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import type { ActiveCheckedInSiteId } from '@serpdirectory/site-contract/active-site-ids'
import { describe, expect, it } from 'vitest'
import {
  buildApproveSubmissionPlans,
  buildRecordSubmissionNotificationPlans,
  buildRejectSubmissionPlans,
  type SubmissionStatementPlan
} from './submission-plans'

const submissionId = '11111111-1111-4111-8111-111111111111'

function database(siteId: ActiveCheckedInSiteId): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(
    readFileSync(
      resolve(import.meta.dirname, '../../../d1/drizzle/0000_remarkable_manta.sql'),
      'utf8'
    )
  )
  db.prepare('INSERT INTO sites(id) VALUES (?)').run(siteId)
  db.prepare(
    `INSERT INTO categories(site_id,slug,name,description,sort_order,is_active)
    VALUES (?,'tools','Tools','Tools',0,1)`
  ).run(siteId)
  db.prepare(
    `INSERT INTO publication_state(site_id,version,checksum,published_at)
    VALUES (?,1,'before','2026-01-01T00:00:00.000Z')`
  ).run(siteId)
  db.prepare(
    `INSERT INTO listing_submissions
      (id,site_id,slug,name,description,website,content,category_slug,logo_url,status,
       access_token_hash,badge_verified_at)
    VALUES (?,?,'example.com','Example','Description','https://example.com/','Content','tools',
      'https://example.com/logo.png','verified','hash','2026-08-01T00:00:00.000Z')`
  ).run(submissionId, siteId)
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

function approvalPlans(siteId: ActiveCheckedInSiteId) {
  const afterChecksum = createHash('sha256').update('after').digest('hex')
  return buildApproveSubmissionPlans({
    afterChecksum,
    beforeChecksum: 'before',
    listingId: `submission_${submissionId}`,
    manifestId: `verified-submission-${submissionId}`,
    now: '2026-08-01T01:00:00.000Z',
    reviewer: 'reviewer',
    runId: `submission_publish_${submissionId}`,
    siteId,
    slug: 'example.com',
    submissionId,
    version: 1
  })
}

describe('protected submission statement plans', () => {
  for (const siteId of ['serp.software', 'pornvideodownloaders.com'] as const) {
    it(`atomically promotes normalized data for ${siteId}`, () => {
      const db = database(siteId)
      execute(db, approvalPlans(siteId))

      expect(db.prepare('SELECT status,site_id FROM listings').get()).toEqual({
        site_id: siteId,
        status: 'approved'
      })
      expect(db.prepare('SELECT status,listing_id FROM listing_submissions').get()).toEqual({
        listing_id: `submission_${submissionId}`,
        status: 'approved'
      })
      expect(db.prepare('SELECT version FROM publication_state').get()).toEqual({ version: 2 })
      expect(db.prepare('SELECT outcome FROM publication_runs').get()).toEqual({
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
  }

  it('rolls back every approval side effect when publication state becomes stale', () => {
    const db = database('serp.software')
    db.prepare("UPDATE publication_state SET version=2,checksum='concurrent'").run()

    expect(() => execute(db, approvalPlans('serp.software'))).toThrow(/malformed JSON/u)
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
    const db = database('serp.software')
    const plans = buildRejectSubmissionPlans({
      now: '2026-08-01T01:00:00.000Z',
      reviewer: 'reviewer',
      siteId: 'serp.software',
      submissionId
    })
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

  it('rolls back approval and rejection before any row mutation while cutover is locked', () => {
    for (const plans of [
      approvalPlans('serp.software'),
      buildRejectSubmissionPlans({
        now: '2026-08-01T01:00:00.000Z',
        reviewer: 'reviewer',
        siteId: 'serp.software',
        submissionId
      })
    ]) {
      const db = database('serp.software')
      db.prepare(
        `INSERT INTO migration_runs
          (id,site_id,schema_version,manifest_identity,input_checksum,target_checksum,
           affected_records,outcome)
        VALUES (?,?,1,?,'before','before',0,'started')`
      ).run(
        'd1-cutover-lock-v1:serp.software:run-1',
        'serp.software',
        'd1-cutover-lock-v1:serp.software:run-1'
      )

      expect(() => execute(db, plans)).toThrow(/malformed JSON/u)
      expect(db.prepare('SELECT COUNT(*) AS count FROM listings').get()).toEqual({ count: 0 })
      expect(db.prepare('SELECT COUNT(*) AS count FROM publication_runs').get()).toEqual({
        count: 0
      })
      expect(db.prepare('SELECT status,listing_id FROM listing_submissions').get()).toEqual({
        listing_id: null,
        status: 'verified'
      })
      expect(db.prepare('SELECT version FROM publication_state').get()).toEqual({ version: 1 })
      expect(db.prepare('SELECT COUNT(*) AS count FROM listing_submission_events').get()).toEqual({
        count: 0
      })
    }
  })

  it('atomically blocks the notification ledger write while cutover is locked', () => {
    const db = database('serp.software')
    db.prepare(
      `INSERT INTO migration_runs
        (id,site_id,schema_version,manifest_identity,input_checksum,target_checksum,
         affected_records,outcome)
      VALUES (?,?,1,?,'before','before',0,'started')`
    ).run(
      'd1-cutover-lock-v1:serp.software:run-1',
      'serp.software',
      'd1-cutover-lock-v1:serp.software:run-1'
    )
    const plans = buildRecordSubmissionNotificationPlans({
      externalId: '42',
      externalUrl: 'https://github.com/example/issues/42',
      previewTokenHash: 'a'.repeat(64),
      recipient: 'reviewer',
      siteId: 'serp.software',
      submissionId
    })
    expect(() => execute(db, plans)).toThrow(/malformed JSON/u)
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM listing_submission_notifications').get()
    ).toEqual({ count: 0 })
  })

  it('requires explicit Site identity throughout decision mutations', () => {
    const approvalSql = approvalPlans('serp.software')
      .map(plan => plan.sql)
      .join('\n')
    const rejectionSql = buildRejectSubmissionPlans({
      now: '2026-08-01T01:00:00.000Z',
      reviewer: 'reviewer',
      siteId: 'serp.software',
      submissionId
    })
      .map(plan => plan.sql)
      .join('\n')
    expect(approvalSql).toContain('site_id=?')
    expect(rejectionSql).toContain('site_id=?')
    expect(approvalSql).not.toMatch(/\bTEMP\b/iu)
    expect(rejectionSql).not.toMatch(/\bTEMP\b/iu)
    expect(approvalSql).toContain("json_extract('', '$')")
    expect(rejectionSql).toContain("json_extract('', '$')")
  })
})

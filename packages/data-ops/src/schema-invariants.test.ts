import type { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { NOW, planDatabase, seedLiveListing } from './plan-test-support'

/** CHECK constraints, indexes, and triggers of the #62 data model, against the real migrations. */
function database(): DatabaseSync {
  const db = planDatabase()
  seedLiveListing(db, 'lst_a')
  return db
}

function insertSubmission(
  db: DatabaseSync,
  values: Record<string, string | null>,
  slug = 'example.com'
): void {
  const columns = Object.keys(values)
  db.prepare(
    `INSERT INTO listing_submissions
      (id,slug,name,description,website,content,category_slug,logo_url${columns.map(c => `,${c}`).join('')})
    VALUES (?,?,'Example','d','https://example.com/','c','tools','https://example.com/l.png'${columns
      .map(() => ',?')
      .join('')})`
  ).run(crypto.randomUUID(), slug, ...Object.values(values))
}

describe('listing columns', () => {
  it('defaults to an admin listing with a followed link and refuses other values', () => {
    const db = database()
    expect(db.prepare('SELECT source, link_rel FROM listings').get()).toEqual({
      link_rel: 'follow',
      source: 'admin'
    })
    expect(() => db.exec("UPDATE listings SET source = 'import'")).toThrow(/listings_source_valid/u)
    expect(() => db.exec("UPDATE listings SET link_rel = 'ugc'")).toThrow(
      /listings_link_rel_valid/u
    )
  })

  it('keeps the primary-category triggers on listings', () => {
    const db = database()
    expect(() => db.exec("DELETE FROM listing_categories WHERE listing_id = 'lst_a'")).toThrow(
      /must retain a primary category/u
    )
  })
})

describe('submission status, plan, and decision invariants', () => {
  it('starts as a draft with no plan, and every later status has a chosen plan', () => {
    const db = database()
    insertSubmission(db, {})
    expect(db.prepare('SELECT status, plan FROM listing_submissions').get()).toEqual({
      plan: null,
      status: 'draft'
    })
    expect(() => insertSubmission(db, { status: 'verified' }, 'b.example')).toThrow(
      /listing_submissions_plan_chosen/u
    )
    expect(() =>
      insertSubmission(db, { plan: 'paid', status: 'pending_badge' }, 'c.example')
    ).toThrow(/listing_submissions_pending_badge_free/u)
    expect(() =>
      insertSubmission(db, { paid_at: NOW, plan: 'paid', status: 'draft' }, 'd.example')
    ).toThrow(/listing_submissions_draft_unpaid/u)
  })

  it('ties payment and refund timestamps to the plan', () => {
    const db = database()
    expect(() =>
      insertSubmission(db, { paid_at: NOW, plan: 'free', status: 'pending_badge' })
    ).toThrow(/listing_submissions_payment_matches_plan/u)
    expect(() =>
      insertSubmission(db, { plan: 'paid', refunded_at: NOW, status: 'verified' })
    ).toThrow(/listing_submissions_/u)
    expect(() => insertSubmission(db, { plan: 'paid', status: 'verified' })).toThrow(
      /listing_submissions_verified_qualified/u
    )
    expect(() =>
      insertSubmission(db, { paid_at: NOW, plan: 'paid', status: 'paid_pending_review' })
    ).toThrow(/listing_submissions_live_review_paid/u)
    // Refunded and kept as a free listing.
    insertSubmission(db, {
      listing_id: 'lst_a',
      paid_at: NOW,
      plan: 'free',
      refunded_at: NOW,
      status: 'approved'
    })
  })

  it('records a rejection reason and category together, only on rejected rows', () => {
    const db = database()
    expect(() =>
      insertSubmission(db, { plan: 'free', rejection_reason: 'Spam', status: 'rejected' })
    ).toThrow(/listing_submissions_rejection_complete/u)
    expect(() =>
      insertSubmission(db, {
        plan: 'free',
        rejection_category: 'other',
        rejection_reason: 'Spam',
        status: 'verified'
      })
    ).toThrow(/listing_submissions_rejection_when_rejected/u)
    expect(() =>
      insertSubmission(db, {
        plan: 'free',
        rejection_category: 'terms',
        rejection_reason: 'Spam',
        status: 'rejected'
      })
    ).toThrow(/listing_submissions_rejection_category_valid/u)
  })

  it('keeps one active submission per URL key, drafts included, and frees it on a decision', () => {
    const db = database()
    insertSubmission(db, {})
    expect(() => insertSubmission(db, { plan: 'free', status: 'pending_badge' })).toThrow(
      /UNIQUE constraint failed: listing_submissions.slug/u
    )
    db.exec("UPDATE listing_submissions SET status = 'withdrawn'")
    insertSubmission(db, { plan: 'free', status: 'pending_badge' })
  })

  it('refuses to delete a user who owns submissions, listings, or revisions', () => {
    const db = database()
    insertSubmission(db, { owner_user_id: 'user_owner' })
    expect(() => db.exec("DELETE FROM users WHERE id = 'user_owner'")).toThrow(/FOREIGN KEY/u)
    db.prepare(
      `INSERT INTO listing_owners (listing_id,user_id,verified_via,verified_at)
      VALUES ('lst_a','user_other','paid_claim',?)`
    ).run(NOW)
    expect(() => db.exec("DELETE FROM users WHERE id = 'user_other'")).toThrow(/FOREIGN KEY/u)
  })
})

describe('ownership, URL blocks, and badge checks', () => {
  it('allows one current owner per listing and keeps revoked owners as history', () => {
    const db = database()
    const grant = (user: string) =>
      db
        .prepare(
          `INSERT INTO listing_owners (listing_id,user_id,verified_via,verified_at)
          VALUES ('lst_a',?,'badge_claim',?)`
        )
        .run(user, NOW)
    grant('user_owner')
    expect(() => grant('user_other')).toThrow(/UNIQUE constraint failed/u)
    expect(() => db.exec("UPDATE listing_owners SET revoked_at = 'now'")).toThrow(
      /listing_owners_revocation_complete/u
    )
    db.exec("UPDATE listing_owners SET revoked_at = 'now', revoked_reason = 'badge_removed'")
    grant('user_other')
    expect(() =>
      db
        .prepare(
          `INSERT INTO listing_owners (listing_id,user_id,verified_via,verified_at)
          VALUES ('lst_a','user_owner','email',?)`
        )
        .run(NOW)
    ).toThrow(/listing_owners_verified_via_valid/u)
  })

  it('blocks a URL key once at a time and refuses new submissions while blocked', () => {
    const db = database()
    const block = () =>
      db.exec(`INSERT INTO listing_submission_url_blocks (url_key,reason,blocked_by,blocked_at)
        VALUES ('example.com','Malware','admin','${NOW}')`)
    block()
    expect(block).toThrow(/UNIQUE constraint failed/u)
    expect(() => insertSubmission(db, {})).toThrow(/blocked until an admin lifts the block/u)
    expect(() => db.exec("UPDATE listing_submission_url_blocks SET lifted_at = 'now'")).toThrow(
      /listing_submission_url_blocks_lift_complete/u
    )
    db.exec("UPDATE listing_submission_url_blocks SET lifted_at = 'now', lifted_by = 'admin'")
    insertSubmission(db, {})
    block()
  })

  it('records badge checks where only a conclusive miss counts and a pass needs no reason', () => {
    const db = database()
    const check = (outcome: string, reason: string | null, conclusive: number) =>
      db
        .prepare(
          'INSERT INTO badge_checks (listing_id,checked_at,outcome,reason,conclusive) VALUES (?,?,?,?,?)'
        )
        .run('lst_a', NOW, outcome, reason, conclusive)
    check('pass', null, 1)
    check('fail', 'badge_missing', 1)
    check('fail', 'timeout', 0)
    expect(() => check('pass', null, 0)).toThrow(/badge_checks_pass_conclusive/u)
    expect(() => check('fail', null, 1)).toThrow(/badge_checks_fail_reason/u)
    expect(() => check('error', 'timeout', 0)).toThrow(/badge_checks_outcome_valid/u)
    // Badge history sits outside the catalog: the publication state never moves.
    expect(db.prepare('SELECT version FROM publication_state').get()).toEqual({ version: 1 })
  })
})

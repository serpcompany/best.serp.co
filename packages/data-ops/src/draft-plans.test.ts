import type { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import {
  buildExpireDraftPlans,
  buildMarkDraftReminderSentPlans,
  DRAFT_EXPIRY_HOURS,
  DRAFT_REMINDER_OFFSETS_HOURS,
  draftClockCutoffs,
  draftExpiredEmailKey,
  draftReminderEmailKey,
  selectDraftRemindersDuePlan,
  selectExpiredDraftsPlan
} from './draft-plans'
import { count, execute, planDatabase, query } from './plan-test-support'
import { type SubmissionStatus, submissionStatuses } from './schema'
import {
  buildChooseSubmissionPlanPlans,
  buildReplaceSubmissionContentPlans,
  submissionTransitions
} from './submission-plans'

const SAVED = '2026-09-01T00:00:00.000Z'
const HOUR = 60 * 60 * 1000
const id = '33333333-3333-4333-8333-333333333333'

/** The instant `hours` after the draft was saved. */
function atHour(hours: number): string {
  return new Date(Date.parse(SAVED) + hours * HOUR).toISOString()
}

function insert(
  db: DatabaseSync,
  values: {
    id?: string
    plan?: 'free' | 'paid' | null
    savedAt?: string
    slug?: string
    status?: SubmissionStatus
  } = {}
): string {
  const status = values.status ?? 'draft'
  const submission = values.id ?? id
  const live = status === 'paid_pending_review' || status === 'approved'
  if (live) {
    db.exec(`INSERT INTO listings (id,slug,name,description,website,status,source_kind,
      source_identity,checksum) VALUES ('lst_${submission}','${submission}.example','L','d',
      'https://${submission}.example/','draft','test','${submission}','c')`)
  }
  db.prepare(
    `INSERT INTO listing_submissions
      (id,slug,name,description,website,content,category_slug,logo_url,status,owner_user_id,
       plan,paid_at,listing_id,draft_saved_at,rejection_reason,rejection_category,withdrawal_reason)
    VALUES (?,?,'Example','d','https://example.com/','c','tools','https://example.com/l.png',?,
      'user_owner',?,?,?,?,?,?,?)`
  ).run(
    submission,
    values.slug ?? `${submission}.example`,
    status,
    status === 'draft' ? (values.plan ?? null) : status === 'paid_pending_review' ? 'paid' : 'free',
    status === 'paid_pending_review' ? SAVED : null,
    live ? `lst_${submission}` : null,
    status === 'draft' ? (values.savedAt ?? SAVED) : null,
    status === 'rejected' ? 'Spam' : null,
    status === 'rejected' ? 'other' : null,
    status === 'withdrawn' ? 'owner' : null
  )
  return submission
}

function row(db: DatabaseSync, submission = id): Record<string, unknown> {
  return db.prepare('SELECT * FROM listing_submissions WHERE id=?').get(submission) as Record<
    string,
    unknown
  >
}

function due(db: DatabaseSync, now: string, reminder?: number) {
  return query(db, selectDraftRemindersDuePlan({ limit: 50, now, reminder })) as Array<{
    id: string
    owner_email: string
    reminder: number
  }>
}

function claim(db: DatabaseSync, now: string, reminder: number, submission = id): void {
  execute(db, buildMarkDraftReminderSentPlans({ now, reminder, submissionId: submission }))
}

describe('draft clock schedule', () => {
  it('reminds at +12h, +48h, +7d, +14d, +21d and expires at +30d', () => {
    expect(DRAFT_REMINDER_OFFSETS_HOURS).toEqual([12, 48, 168, 336, 504])
    expect(DRAFT_EXPIRY_HOURS).toBe(720)
    expect(draftClockCutoffs(atHour(720))).toEqual({
      expiryCutoff: SAVED,
      reminderCutoffs: [atHour(708), atHour(672), atHour(552), atHour(384), atHour(216)]
    })
    expect(() => draftClockCutoffs('2026-10-06 12:00:00')).toThrow(/ISO instant/u)
    expect(draftReminderEmailKey(id, 3)).toBe(`submission-draft-reminder:${id}:3`)
    expect(draftExpiredEmailKey(id)).toBe(`submission-draft-expired:${id}`)
    expect(() => draftReminderEmailKey(id, 6)).toThrow(/1 to 5/u)
  })

  it('makes each reminder due once, in order, and claims it exactly once', () => {
    const db = planDatabase()
    insert(db)
    expect(due(db, atHour(11.99))).toEqual([])
    for (const [index, hours] of DRAFT_REMINDER_OFFSETS_HOURS.entries()) {
      const reminder = index + 1
      expect(due(db, atHour(hours)), `reminder ${reminder}`).toMatchObject([
        { id, owner_email: 'owner@example.com', reminder }
      ])
      expect(due(db, atHour(hours), reminder)).toHaveLength(1)
      expect(due(db, atHour(hours), reminder === 5 ? 1 : reminder + 1)).toEqual([])
      claim(db, atHour(hours), reminder)
      expect(row(db)).toMatchObject({
        draft_last_reminder_at: atHour(hours),
        draft_reminders_sent: reminder
      })
      // A repeated or concurrent claim fails the batch: the email goes out once.
      expect(() => claim(db, atHour(hours), reminder)).toThrow(/malformed JSON/u)
      expect(due(db, atHour(hours))).toEqual([])
    }
    expect(due(db, atHour(719))).toEqual([])
  })

  it('sends only the latest due reminder after missed runs', () => {
    const db = planDatabase()
    insert(db)
    expect(due(db, atHour(8 * 24))).toMatchObject([{ reminder: 3 }])
    claim(db, atHour(8 * 24), 3)
    expect(row(db).draft_reminders_sent).toBe(3)
    expect(() => claim(db, atHour(8 * 24), 2)).toThrow(/malformed JSON/u)
    expect(due(db, atHour(13 * 24))).toEqual([])
    expect(due(db, atHour(14 * 24))).toMatchObject([{ reminder: 4 }])
  })

  it('refuses a reminder before it is due or after the draft expired', () => {
    const db = planDatabase()
    insert(db)
    expect(() => claim(db, atHour(11), 1)).toThrow(/malformed JSON/u)
    expect(() => claim(db, atHour(720), 5)).toThrow(/malformed JSON/u)
    expect(row(db)).toMatchObject({ draft_last_reminder_at: null, draft_reminders_sent: 0 })
    expect(() =>
      buildMarkDraftReminderSentPlans({ now: atHour(12), reminder: 0, submissionId: id })
    ).toThrow(/1 to 5/u)
  })

  it('stops reminding once a plan is chosen, but still expires a paid draft that never paid', () => {
    const db = planDatabase()
    insert(db, { id: 'paid', plan: 'paid' })
    insert(db, { id: 'free', status: 'pending_badge' })
    insert(db, { id: 'open' })
    expect(due(db, atHour(24)).map(item => item.id)).toEqual(['open'])
    expect(() => claim(db, atHour(24), 1, 'paid')).toThrow(/malformed JSON/u)
    const expired = query(db, selectExpiredDraftsPlan({ limit: 10, now: atHour(720) })) as Array<{
      id: string
    }>
    expect(expired.map(item => item.id)).toEqual(['open', 'paid'])
  })

  it('keeps the clock when the draft is edited', () => {
    const db = planDatabase()
    insert(db)
    execute(
      db,
      buildReplaceSubmissionContentPlans({
        actor: 'user_owner',
        content: {
          categorySlug: 'apps',
          content: 'Edited',
          description: 'Edited',
          faqs: [],
          logoUrl: 'https://example.com/l.png',
          name: 'Edited',
          resourceLinks: []
        },
        expectedStatuses: ['draft'],
        now: atHour(700),
        ownerUserId: 'user_owner',
        submissionId: id
      })
    )
    expect(row(db)).toMatchObject({ draft_saved_at: SAVED, name: 'Edited' })
    expect(query(db, selectExpiredDraftsPlan({ limit: 10, now: atHour(720) }))).toHaveLength(1)
  })
})

describe('draft expiry transition (compare-and-swap with changes() assertions)', () => {
  it('withdraws only a draft that is 30 days old, records `expired`, and frees the URL', () => {
    expect(submissionTransitions.expire).toEqual({ from: ['draft'], to: 'withdrawn' })
    for (const status of submissionStatuses) {
      const db = planDatabase()
      insert(db, { slug: 'example.com', status })
      const before = row(db)
      const events = count(db, 'SELECT COUNT(*) AS count FROM listing_submission_events')
      const plans = buildExpireDraftPlans({ now: atHour(720), submissionId: id })
      if ((submissionTransitions.expire.from as readonly string[]).includes(status)) {
        execute(db, plans)
        expect(row(db)).toMatchObject({
          draft_saved_at: SAVED,
          status: 'withdrawn',
          updated_at: atHour(720),
          withdrawal_reason: 'expired'
        })
        expect(db.prepare('SELECT event_type,actor FROM listing_submission_events').all()).toEqual([
          { actor: 'draft-expiry', event_type: 'expired' }
        ])
        insert(db, { id: crypto.randomUUID(), savedAt: atHour(720), slug: 'example.com' })
      } else {
        expect(() => execute(db, plans), `${status} must be refused`).toThrow(/malformed JSON/u)
        expect(row(db)).toEqual(before)
        expect(count(db, 'SELECT COUNT(*) AS count FROM listing_submission_events')).toBe(events)
      }
      db.close()
    }
  })

  it('refuses to expire a draft before day 30, or twice', () => {
    const db = planDatabase()
    insert(db)
    expect(() =>
      execute(db, buildExpireDraftPlans({ now: atHour(719.99), submissionId: id }))
    ).toThrow(/malformed JSON/u)
    expect(row(db).status).toBe('draft')
    execute(db, buildExpireDraftPlans({ now: atHour(720), submissionId: id }))
    expect(() =>
      execute(db, buildExpireDraftPlans({ now: atHour(721), submissionId: id }))
    ).toThrow(/malformed JSON/u)
    expect(count(db, 'SELECT COUNT(*) AS count FROM listing_submission_events')).toBe(1)
  })

  it('refuses a plan choice once the draft expired, even before the job withdrew it', () => {
    const db = planDatabase()
    insert(db)
    for (const plan of ['free', 'paid'] as const) {
      expect(() =>
        execute(
          db,
          buildChooseSubmissionPlanPlans({
            now: atHour(720),
            ownerUserId: 'user_owner',
            plan,
            submissionId: id
          })
        )
      ).toThrow(/malformed JSON/u)
    }
    execute(
      db,
      buildChooseSubmissionPlanPlans({
        now: atHour(719),
        ownerUserId: 'user_owner',
        plan: 'free',
        submissionId: id
      })
    )
    expect(row(db)).toMatchObject({ plan: 'free', status: 'pending_badge' })
    expect(() =>
      execute(db, buildExpireDraftPlans({ now: atHour(720), submissionId: id }))
    ).toThrow(/malformed JSON/u)
  })
})

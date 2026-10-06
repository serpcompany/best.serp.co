import { beforeEach, describe, expect, it } from 'vitest'
import { createDatabase } from './client'
import { createDraftJobOperations } from './draft-jobs'
import { SqliteD1 } from './test-support'

const SAVED = '2026-09-01T00:00:00.000Z'
const HOUR = 60 * 60 * 1000

function atHour(hours: number): string {
  return new Date(Date.parse(SAVED) + hours * HOUR).toISOString()
}

describe('draft job operations', () => {
  let sqlite: SqliteD1

  beforeEach(() => {
    sqlite = new SqliteD1()
    sqlite.database.exec(`
      INSERT INTO users(id,name,email,email_verified) VALUES ('user_owner','','owner@example.com',1);
      INSERT INTO listing_submissions
        (id,slug,block_key,block_covers_subdomains,name,description,website,content,category_slug,
          logo_url,status,owner_user_id,plan,draft_saved_at)
      VALUES
        ('open','open.example','open.example',1,'Open','d','https://open.example/','','tools',
          'https://open.example/l.png','draft','user_owner',NULL,'${SAVED}'),
        ('paid','paid.example','paid.example',1,'Paid','d','https://paid.example/','','tools',
          'https://paid.example/l.png','draft','user_owner','paid','${atHour(1)}');
    `)
  })

  function operations() {
    return createDraftJobOperations({ client: createDatabase(sqlite.asD1Database()) })
  }

  it('reads due reminders with the website and claims each one once', async () => {
    const due = await operations().remindersDue({ limit: 10, now: atHour(13) })
    expect(due).toEqual([
      {
        draftSavedAt: SAVED,
        id: 'open',
        name: 'Open',
        ownerEmail: 'owner@example.com',
        reminder: 1,
        slug: 'open.example',
        variant: 'choose_plan',
        website: 'https://open.example/'
      },
      expect.objectContaining({ id: 'paid', reminder: 1, variant: 'complete_checkout' })
    ])
    const claim = { now: atHour(13), reminder: 1 as const, submissionId: 'open' }
    await expect(operations().claimReminder({ ...claim, variant: 'choose_plan' })).resolves.toBe(
      true
    )
    await expect(operations().claimReminder({ ...claim, variant: 'choose_plan' })).resolves.toBe(
      false
    )
    // The claim must match the draft's state: an unpaid paid draft is not `choose_plan`.
    await expect(
      operations().claimReminder({ ...claim, submissionId: 'paid', variant: 'choose_plan' })
    ).resolves.toBe(false)
    expect(
      (await operations().remindersDue({ limit: 10, now: atHour(13) })).map(item => item.id)
    ).toEqual(['paid'])
  })

  it('expires drafts at 30 days once and frees nothing early', async () => {
    await expect(operations().expiredDrafts({ limit: 10, now: atHour(719) })).resolves.toEqual([])
    const expired = await operations().expiredDrafts({ limit: 10, now: atHour(721) })
    expect(expired).toEqual([
      {
        draftSavedAt: SAVED,
        id: 'open',
        name: 'Open',
        ownerEmail: 'owner@example.com',
        slug: 'open.example',
        website: 'https://open.example/'
      },
      expect.objectContaining({ id: 'paid' })
    ])
    await expect(
      operations().expireDraft({ now: atHour(721), submissionId: 'open' })
    ).resolves.toBe(true)
    await expect(
      operations().expireDraft({ now: atHour(721), submissionId: 'open' })
    ).resolves.toBe(false)
    expect(
      sqlite.database
        .prepare("SELECT status,withdrawal_reason FROM listing_submissions WHERE id='open'")
        .get()
    ).toEqual({ status: 'withdrawn', withdrawal_reason: 'expired' })
  })

  // PR #84 review round 2, finding 5: failed draft emails that can never be sent again must
  // not fill the page ahead of the ones that can.
  it('retries only failed draft emails that still apply, past any number that never will', async () => {
    const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
    const submission = sqlite.database.prepare(`INSERT INTO listing_submissions
      (id,slug,block_key,block_covers_subdomains,name,description,website,content,category_slug,
        logo_url,status,owner_user_id,plan,draft_saved_at,draft_reminders_sent,draft_last_reminder_at,
        withdrawal_reason)
      VALUES (?,?,?,1,?,'d',?,'','tools','https://x.example/l.png',?,'user_owner',?,?,?,?,?)`)
    const add = (
      n: number,
      status: string,
      plan: string | null,
      reminders: number,
      reason: string | null
    ) => {
      const slug = `s${n}.example`
      submission.run(
        id(n),
        slug,
        slug,
        `S${n}`,
        `https://${slug}/`,
        status,
        plan,
        SAVED,
        reminders,
        atHour(13),
        reason
      )
    }
    const delivery = sqlite.database.prepare(`INSERT INTO email_deliveries
      (template_id,event_key,provider,status,attempts,updated_at) VALUES (?,?,'test','failed',?,?)`)
    // 100 drafts that moved on (a plan chosen) after their first reminder failed, and the same
    // 100 with an expiry email that used up its attempts: all older than the real retries.
    for (let n = 1; n <= 100; n += 1) {
      add(n, 'pending_badge', 'free', 1, null)
      delivery.run(
        'draft-reminder',
        `submission-draft-reminder:${id(n)}:1`,
        1,
        '2026-09-01 00:00:00'
      )
      delivery.run('draft-expired', `submission-draft-expired:${id(n)}`, 5, '2026-09-01 00:00:00')
    }
    // An earlier reminder of a draft whose second reminder is now the latest.
    add(101, 'draft', null, 2, null)
    delivery.run(
      'draft-reminder',
      `submission-draft-reminder:${id(101)}:1`,
      1,
      '2026-09-01 00:00:00'
    )
    // Still due: the latest reminder of an open draft, and an expired draft's notice.
    add(102, 'draft', null, 1, null)
    delivery.run(
      'draft-reminder',
      `submission-draft-reminder:${id(102)}:1`,
      2,
      '2026-09-02 00:00:00'
    )
    add(103, 'withdrawn', null, 1, 'expired')
    delivery.run('draft-expired', `submission-draft-expired:${id(103)}`, 1, '2026-09-02 00:01:00')

    const retry = (limit: number) =>
      operations().retryableEmails({ limit, maxAttempts: 5, now: atHour(14) })
    expect((await retry(100)).map(item => [item.kind, item.draft.id])).toEqual([
      ['reminder', id(102)],
      ['expired', id(103)]
    ])
    expect((await retry(1)).map(item => item.eventKey)).toEqual([
      `submission-draft-reminder:${id(102)}:1`
    ])
  })
})

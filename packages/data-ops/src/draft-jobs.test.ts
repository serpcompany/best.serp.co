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
})

import { beforeEach, describe, expect, it } from 'vitest'
import {
  BADGE_PROGRAM_ACTOR,
  type BadgeProgramOperations,
  badgeProgramEmailKey,
  createBadgeProgramOperations,
  type PendingConfirmation
} from './badge-program'
import { createDatabase } from './client'
import { seedLiveListing } from './plan-test-support'
import { SqliteD1 } from './test-support'

/** Monday 2026-10-05 03:15 UTC: a weekly cycle start. */
const CYCLE = '2026-10-05T03:15:00.000Z'
const HOUR = 60 * 60 * 1000

function at(hours: number, from = CYCLE): string {
  return new Date(Date.parse(from) + hours * HOUR).toISOString()
}

const MISSING = { conclusive: true, outcome: 'fail', reason: 'badge_missing' } as const
const TIMEOUT = { conclusive: false, outcome: 'fail', reason: 'fetch_timeout' } as const
const PASS = { outcome: 'pass' } as const

describe('badge program operations', () => {
  let sqlite: SqliteD1
  let ops: BadgeProgramOperations

  const db = () => sqlite.database
  const one = <T>(sql: string, ...params: Array<string | number>) =>
    db()
      .prepare(sql)
      .get(...params) as T
  const all = <T>(sql: string, ...params: Array<string | number>) =>
    db()
      .prepare(sql)
      .all(...params) as T[]
  const version = () =>
    one<{ version: number }>('SELECT version FROM publication_state WHERE id=1').version

  beforeEach(() => {
    sqlite = new SqliteD1()
    db().exec(`
      INSERT INTO categories (slug, name, description, sort_order, is_active)
        VALUES ('tools', 'Tools', 'Tools', 0, 1);
      INSERT INTO publication_state (id, version, checksum, published_at)
        VALUES (1, 1, 'before', '2026-01-01T00:00:00.000Z');
      INSERT INTO users (id, name, email, email_verified) VALUES
        ('user_free', 'Free', 'free@example.com', 1),
        ('user_claim', 'Claim', 'claim@example.com', 1),
        ('user_paid', 'Paid', 'paid@example.com', 1);
    `)
    for (const id of [
      'lst_free',
      'lst_paid',
      'lst_admin',
      'lst_claim',
      'lst_paidclaim',
      'lst_down'
    ]) {
      seedLiveListing(db(), id)
    }
    db().exec(`
      UPDATE listings SET source='submission' WHERE id IN ('lst_free','lst_paid','lst_down');
      UPDATE listings SET is_active=0 WHERE id='lst_down';
      INSERT INTO listing_submissions (id,slug,name,description,website,content,category_slug,
        logo_url,status,plan,paid_at,listing_id,owner_user_id) VALUES
        ('sub_free','lst_free.example','Free','d','https://lst_free.example/','c','tools','l',
          'approved','free',NULL,'lst_free','user_free'),
        ('sub_paid','lst_paid.example','Paid','d','https://lst_paid.example/','c','tools','l',
          'approved','paid','2026-09-01T00:00:00.000Z','lst_paid','user_paid'),
        ('sub_down','lst_down.example','Down','d','https://lst_down.example/','c','tools','l',
          'approved','free',NULL,'lst_down','user_free');
      INSERT INTO listing_owners (listing_id,user_id,verified_via,verified_at) VALUES
        ('lst_free','user_free','submission','2026-09-01T00:00:00.000Z'),
        ('lst_paid','user_paid','submission','2026-09-01T00:00:00.000Z'),
        ('lst_claim','user_claim','badge_claim','2026-09-01T00:00:00.000Z'),
        ('lst_paidclaim','user_paid','paid_claim','2026-09-01T00:00:00.000Z');
    `)
    ops = createBadgeProgramOperations({ client: createDatabase(sqlite.asD1Database()) })
  })

  const weekly = (now = at(1)) => ops.weeklyDue({ cycleStart: CYCLE, limit: 10, now })
  const listing = async (id: string, now = at(1)) => {
    const found = (await weekly(now)).find(item => item.id === id)
    if (!found) throw new Error(`${id} is not due`)
    return found
  }
  const warnFree = async () => {
    const recorded = await ops.recordWeekly({
      cycleStart: CYCLE,
      listing: await listing('lst_free'),
      now: at(1),
      result: MISSING
    })
    if (!recorded.recorded) throw new Error('not recorded')
    return recorded
  }
  /** The next day's window (Tuesday 03:45 UTC), when a Monday 04:15 warning is due. */
  const DAILY = '2026-10-06T03:45:00.000Z'
  const due = (now = at(0.25, DAILY), attemptSince = DAILY) =>
    ops.confirmationsDue({ attemptSince, dueBefore: at(-20, attemptSince), limit: 10, now })
  const pending = async (id: string, now?: string): Promise<PendingConfirmation> => {
    const found = (await due(now)).find(item => item.id === id)
    if (!found) throw new Error(`${id} has no due confirmation`)
    return found
  }

  it('checks only free submitted listings and badge-claimed listings, never admin or paid ones', async () => {
    expect(await weekly()).toEqual([
      {
        branch: 'revoke',
        id: 'lst_claim',
        name: 'Live lst_claim',
        ownerEmail: 'claim@example.com',
        ownerUserId: 'user_claim',
        slug: 'lst_claim.example',
        website: 'https://lst_claim.example/'
      },
      {
        branch: 'unpublish',
        id: 'lst_free',
        name: 'Live lst_free',
        ownerEmail: 'free@example.com',
        ownerUserId: 'user_free',
        slug: 'lst_free.example',
        website: 'https://lst_free.example/'
      }
    ])
    // A refund that kept the listing as a free one brings it into the program (paid → free).
    db().exec(
      "UPDATE listing_submissions SET plan='free',refunded_at='2026-09-02T00:00:00.000Z' WHERE id='sub_paid'"
    )
    expect((await weekly()).map(item => item.id)).toEqual(['lst_claim', 'lst_free', 'lst_paid'])
  })

  it('records one weekly check per listing and cycle, whatever the outcome', async () => {
    const free = await listing('lst_free')
    const claim = await listing('lst_claim')
    const passed = await ops.recordWeekly({
      cycleStart: CYCLE,
      listing: free,
      now: at(1),
      result: PASS
    })
    expect(passed).toMatchObject({ action: 'none', email: null, recorded: true })
    // Another run that checked the same listing loses the compare-and-swap.
    await expect(
      ops.recordWeekly({ cycleStart: CYCLE, listing: free, now: at(1), result: PASS })
    ).resolves.toEqual({ recorded: false })
    // An inconclusive result is recorded, sends nothing, and takes the listing out of the cycle.
    await expect(
      ops.recordWeekly({ cycleStart: CYCLE, listing: claim, now: at(1), result: TIMEOUT })
    ).resolves.toMatchObject({ email: null, recorded: true })
    expect(await weekly(at(2))).toEqual([])
    expect(
      all('SELECT listing_id,outcome,reason,conclusive,kind FROM badge_checks ORDER BY id')
    ).toEqual([
      { conclusive: 1, kind: 'weekly', listing_id: 'lst_free', outcome: 'pass', reason: null },
      {
        conclusive: 0,
        kind: 'weekly',
        listing_id: 'lst_claim',
        outcome: 'fail',
        reason: 'fetch_timeout'
      }
    ])
    // The next cycle checks both again; the catalog never changed.
    const next = at(7 * 24)
    expect(
      (await ops.weeklyDue({ cycleStart: next, limit: 10, now: at(1, next) })).map(item => item.id)
    ).toEqual(['lst_claim', 'lst_free'])
    expect(version()).toBe(1)
  })

  it('takes the least recently checked listings first when a cycle outgrows its batch', async () => {
    const claim = await listing('lst_claim')
    await ops.recordWeekly({ cycleStart: CYCLE, listing: claim, now: at(1), result: PASS })
    // Next cycle: the free listing was never checked, so it comes first despite its id.
    const next = at(7 * 24)
    const first = await ops.weeklyDue({ cycleStart: next, limit: 1, now: at(1, next) })
    expect(first.map(item => item.id)).toEqual(['lst_free'])
  })

  it('warns on a conclusive weekly miss and holds the listing for its confirmation', async () => {
    const warned = await warnFree()
    expect(warned).toMatchObject({
      action: 'none',
      email: {
        checkId: warned.id,
        checkedAt: at(1),
        listing: {
          name: 'Live lst_free',
          slug: 'lst_free.example',
          website: 'https://lst_free.example/'
        },
        reason: 'badge_missing',
        template: 'badge-missing',
        to: 'free@example.com'
      }
    })
    // Not due before the window that starts at least 20 hours after the warning.
    await expect(
      ops.confirmationsDue({
        attemptSince: '2026-10-05T03:45:00.000Z',
        dueBefore: at(-20, '2026-10-05T03:45:00.000Z'),
        limit: 10,
        now: at(2)
      })
    ).resolves.toEqual([])
    expect(await pending('lst_free')).toMatchObject({
      branch: 'unpublish',
      warning: { checkedAt: at(1), id: warned.id, reason: 'badge_missing' }
    })
    // While in warning, a new weekly cycle leaves it to the confirmation pass.
    const next = at(7 * 24)
    expect(
      (await ops.weeklyDue({ cycleStart: next, limit: 10, now: at(-2, next) })).map(i => i.id)
    ).toEqual(['lst_claim'])
    expect(version()).toBe(1)
  })

  it('ends the warning on a passing recheck', async () => {
    await warnFree()
    const confirmation = await ops.recordConfirmation({
      attemptSince: DAILY,
      listing: await pending('lst_free'),
      now: at(0.25, DAILY),
      result: PASS
    })
    expect(confirmation).toMatchObject({ action: 'none', email: null, recorded: true })
    expect(await due()).toEqual([])
    expect(one('SELECT is_active FROM listings WHERE id=?', 'lst_free')).toEqual({ is_active: 1 })
    expect(version()).toBe(1)
  })

  it('retries an inconclusive recheck once per daily window', async () => {
    await warnFree()
    const confirmation = await pending('lst_free')
    await expect(
      ops.recordConfirmation({
        attemptSince: DAILY,
        listing: confirmation,
        now: at(0.25, DAILY),
        result: TIMEOUT
      })
    ).resolves.toMatchObject({ action: 'none', email: null, recorded: true })
    // Not again in the same window, even by another run.
    expect(await due(at(1, DAILY))).toEqual([])
    await expect(
      ops.recordConfirmation({
        attemptSince: DAILY,
        listing: confirmation,
        now: at(1, DAILY),
        result: MISSING
      })
    ).resolves.toEqual({ recorded: false })
    // The next window rechecks it.
    const nextDay = at(24, DAILY)
    expect((await due(at(0.25, nextDay), nextDay)).map(item => item.id)).toEqual(['lst_free'])
    expect(one('SELECT is_active FROM listings WHERE id=?', 'lst_free')).toEqual({ is_active: 1 })
  })

  it('unpublishes a free submitted listing on a confirmed miss, in the same batch as the check', async () => {
    const warned = await warnFree()
    const confirmed = await ops.recordConfirmation({
      attemptSince: DAILY,
      listing: await pending('lst_free'),
      now: at(0.25, DAILY),
      result: MISSING
    })
    if (!confirmed.recorded) throw new Error('not recorded')
    expect(confirmed).toMatchObject({
      action: 'unpublished',
      email: {
        checkId: confirmed.id,
        checkedAt: at(0.25, DAILY),
        template: 'listing-unlisted',
        to: 'free@example.com',
        warnedAt: at(1)
      }
    })
    expect(one('SELECT status,is_active FROM listings WHERE id=?', 'lst_free')).toEqual({
      is_active: 0,
      status: 'approved'
    })
    expect(version()).toBe(2)
    expect(
      one<{ actor: string; detail: string; event_type: string }>(
        'SELECT event_type,actor,detail FROM listing_events WHERE listing_id=?',
        'lst_free'
      )
    ).toEqual({
      actor: BADGE_PROGRAM_ACTOR,
      detail: JSON.stringify({ note: null, reason: 'badge_missing' }),
      event_type: 'unpublished'
    })
    expect(
      one(
        'SELECT event_type,detail FROM listing_submission_events WHERE submission_id=?',
        'sub_free'
      )
    ).toEqual({ detail: 'badge_missing', event_type: 'unpublished' })
    expect(
      one(
        "SELECT manifest_id,outcome,workflow FROM publication_runs WHERE manifest_id LIKE 'listing-unpublish-%'"
      )
    ).toEqual({
      manifest_id: 'listing-unpublish-lst_free-v2',
      outcome: 'succeeded',
      workflow: 'worker-cron/badge-program'
    })
    expect(
      all(
        'SELECT id,kind,outcome,conclusive FROM badge_checks WHERE listing_id=? ORDER BY id',
        'lst_free'
      )
    ).toEqual([
      { conclusive: 1, id: warned.id, kind: 'weekly', outcome: 'fail' },
      { conclusive: 1, id: confirmed.id, kind: 'confirmation', outcome: 'fail' }
    ])
    // Out of the program: nothing is due, and the listing stays down (no automatic restore).
    expect(await due(at(24, DAILY), at(24, DAILY))).toEqual([])
    expect((await weekly(at(8 * 24))).map(item => item.id)).toEqual(['lst_claim'])
  })

  it('removes a badge claimer as owner on a confirmed miss and keeps the listing live', async () => {
    const warned = await ops.recordWeekly({
      cycleStart: CYCLE,
      listing: await listing('lst_claim'),
      now: at(1),
      result: { conclusive: true, outcome: 'fail', reason: 'link_not_followed' }
    })
    expect(warned).toMatchObject({ email: { template: 'badge-missing', to: 'claim@example.com' } })
    const confirmed = await ops.recordConfirmation({
      attemptSince: DAILY,
      listing: await pending('lst_claim'),
      now: at(0.25, DAILY),
      result: MISSING
    })
    if (!confirmed.recorded) throw new Error('not recorded')
    expect(confirmed).toMatchObject({
      action: 'revoked',
      email: { checkId: confirmed.id, template: 'ownership-removed', to: 'claim@example.com' }
    })
    expect(one('SELECT is_active FROM listings WHERE id=?', 'lst_claim')).toEqual({ is_active: 1 })
    expect(
      one('SELECT revoked_at,revoked_reason FROM listing_owners WHERE listing_id=?', 'lst_claim')
    ).toEqual({ revoked_at: at(0.25, DAILY), revoked_reason: 'badge_removed' })
    expect(
      one('SELECT event_type,actor FROM listing_events WHERE listing_id=?', 'lst_claim')
    ).toEqual({ actor: BADGE_PROGRAM_ACTOR, event_type: 'owner_revoked' })
    expect(version()).toBe(2)
    // Curated now: never checked again until someone claims it with the badge.
    expect((await weekly(at(8 * 24))).map(item => item.id)).toEqual(['lst_free'])
  })

  it('records nothing when the listing moved on before the recheck', async () => {
    await warnFree()
    const confirmation = await pending('lst_free')
    // An admin unpublished it meanwhile (or it was paid for, or deleted).
    db().exec("UPDATE listings SET is_active=0 WHERE id='lst_free'")
    await expect(
      ops.recordConfirmation({
        attemptSince: DAILY,
        listing: confirmation,
        now: at(0.25, DAILY),
        result: MISSING
      })
    ).resolves.toEqual({ recorded: false })
    expect(version()).toBe(1)
    expect(one('SELECT COUNT(*) AS count FROM badge_checks')).toEqual({ count: 1 })
  })

  it('retries the consequence once after losing a publication race', async () => {
    await warnFree()
    const confirmation = await pending('lst_free')
    // Another publication lands between the snapshot and the batch, once.
    const binding = sqlite.asD1Database()
    let raced = false
    const racing = {
      ...binding,
      prepare: binding.prepare.bind(binding),
      async batch(statements: D1PreparedStatement[]) {
        if (!raced && statements.length > 2) {
          raced = true
          db().exec("UPDATE publication_state SET version=version+1,checksum='other' WHERE id=1")
        }
        return binding.batch(statements)
      }
    } as unknown as D1Database
    const racingOps = createBadgeProgramOperations({ client: createDatabase(racing) })
    await expect(
      racingOps.recordConfirmation({
        attemptSince: DAILY,
        listing: confirmation,
        now: at(0.25, DAILY),
        result: MISSING
      })
    ).resolves.toMatchObject({ action: 'unpublished', recorded: true })
    expect(version()).toBe(3)
  })

  it('lets a stale warning lapse after a week and starts over', async () => {
    await warnFree()
    const later = at(8 * 24)
    expect(
      (await ops.weeklyDue({ cycleStart: at(7 * 24), limit: 10, now: later })).map(i => i.id)
    ).toEqual(['lst_claim', 'lst_free'])
    const lapsedWindow = '2026-10-13T03:45:00.000Z'
    expect(await due(at(0.5, lapsedWindow), lapsedWindow)).toEqual([])
  })

  it('warns again before a republished listing can be unpublished again', async () => {
    await warnFree()
    await ops.recordConfirmation({
      attemptSince: DAILY,
      listing: await pending('lst_free'),
      now: at(0.25, DAILY),
      result: MISSING
    })
    db().exec("UPDATE listings SET is_active=1 WHERE id='lst_free'")
    const next = at(7 * 24)
    const again = await ops.weeklyDue({ cycleStart: next, limit: 10, now: at(1, next) })
    expect(again.map(item => item.id)).toEqual(['lst_claim', 'lst_free'])
    await expect(
      ops.recordWeekly({
        cycleStart: next,
        listing: again[1] as (typeof again)[number],
        now: at(1, next),
        result: MISSING
      })
    ).resolves.toMatchObject({ email: { template: 'badge-missing' } })
    expect(one('SELECT is_active FROM listings WHERE id=?', 'lst_free')).toEqual({ is_active: 1 })
  })

  it('finds the failed program emails that still apply, to send them again', async () => {
    const warning = await warnFree()
    const claimWarning = await ops.recordWeekly({
      cycleStart: CYCLE,
      listing: await listing('lst_claim'),
      now: at(1),
      result: MISSING
    })
    if (!claimWarning.recorded) throw new Error('not recorded')
    const unlisted = await ops.recordConfirmation({
      attemptSince: DAILY,
      listing: await pending('lst_free'),
      now: at(0.25, DAILY),
      result: MISSING
    })
    if (!unlisted.recorded) throw new Error('not recorded')
    const ledger = db().prepare(
      `INSERT INTO email_deliveries (template_id,event_key,provider,status,attempts)
        VALUES (?,?,'test',?,?)`
    )
    ledger.run('badge-missing', badgeProgramEmailKey('badge-missing', warning.id), 'failed', 1)
    ledger.run('badge-missing', badgeProgramEmailKey('badge-missing', claimWarning.id), 'failed', 1)
    ledger.run(
      'listing-unlisted',
      badgeProgramEmailKey('listing-unlisted', unlisted.id),
      'failed',
      2
    )
    const now = at(1, DAILY)
    const retries = await ops.retryableEmails({ limit: 10, maxAttempts: 5, now })
    // The free listing's warning no longer applies (it was confirmed); its unlisted email does.
    expect(retries).toEqual([
      expect.objectContaining({
        checkId: claimWarning.id,
        template: 'badge-missing',
        to: 'claim@example.com'
      }),
      expect.objectContaining({
        checkId: unlisted.id,
        template: 'listing-unlisted',
        to: 'free@example.com',
        warnedAt: at(1)
      })
    ])
    // Sent, or out of attempts: nothing to send again.
    db().exec("UPDATE email_deliveries SET status='sent' WHERE template_id='badge-missing'")
    db().exec("UPDATE email_deliveries SET attempts=5 WHERE template_id='listing-unlisted'")
    await expect(ops.retryableEmails({ limit: 10, maxAttempts: 5, now })).resolves.toEqual([])
  })

  it('finds a failed ownership-removed email for the former owner', async () => {
    await ops.recordWeekly({
      cycleStart: CYCLE,
      listing: await listing('lst_claim'),
      now: at(1),
      result: MISSING
    })
    const revoked = await ops.recordConfirmation({
      attemptSince: DAILY,
      listing: await pending('lst_claim'),
      now: at(0.25, DAILY),
      result: MISSING
    })
    if (!revoked.recorded) throw new Error('not recorded')
    db()
      .prepare(`INSERT INTO email_deliveries (template_id,event_key,provider,status,attempts)
        VALUES (?,?,'test',?,?)`)
      .run('ownership-removed', badgeProgramEmailKey('ownership-removed', revoked.id), 'failed', 1)
    await expect(
      ops.retryableEmails({ limit: 10, maxAttempts: 5, now: at(1, DAILY) })
    ).resolves.toEqual([
      {
        checkId: revoked.id,
        checkedAt: at(0.25, DAILY),
        listing: {
          name: 'Live lst_claim',
          slug: 'lst_claim.example',
          website: 'https://lst_claim.example/'
        },
        template: 'ownership-removed',
        to: 'claim@example.com'
      }
    ])
    // After a week it no longer applies.
    await expect(
      ops.retryableEmails({ limit: 10, maxAttempts: 5, now: at(8 * 24, DAILY) })
    ).resolves.toEqual([])
  })

  it('keys each email by template and check', () => {
    expect(badgeProgramEmailKey('badge-missing', 7)).toBe('badge-missing:7')
    expect(() => badgeProgramEmailKey('listing-unlisted', 0)).toThrow(/check id/u)
  })
})

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SqliteD1 } from '../../../../packages/data-ops/src/test-support'
import { BADGE_DAILY_CRON, BADGE_WEEKLY_CRON } from '../badge-program/schedule'
import { clearDevEmailOutbox, readDevEmailOutbox } from '../email/senders'
import type { SiteFeatures } from '../features'
import { submissionBadgeVerificationTargets } from '../submissions/presentation'
import {
  badgeProgramEnabled,
  badgeProgramJob,
  createBadgeProgramJob,
  DRAFT_JOBS_CRON,
  draftJobs,
  handleScheduled,
  type ScheduledJob,
  scheduledJobs
} from './scheduled'

const SAVED = '2026-09-01T00:00:00.000Z'
const HOUR = 60 * 60 * 1000
const OWNER = 'owner@example.com'

function atHour(hours: number): number {
  return Date.parse(SAVED) + hours * HOUR
}

function draft(id: string, savedAt: string, plan: 'paid' | null = null): string {
  return `INSERT INTO listing_submissions
    (id,slug,block_key,block_covers_subdomains,name,description,website,content,category_slug,
      logo_url,status,owner_user_id,plan,draft_saved_at)
    VALUES ('${id}','${id}.example','${id}.example',1,'${id[0]?.toUpperCase()}${id.slice(1)}','d',
      'https://${id}.example/','','tools','https://${id}.example/l.png','draft','user_owner',
      ${plan ? `'${plan}'` : 'NULL'},'${savedAt}');`
}

describe('scheduled handler', () => {
  let sqlite: SqliteD1
  let pending: Promise<unknown>[]

  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    clearDevEmailOutbox()
    pending = []
    sqlite = new SqliteD1()
    sqlite.database.exec(`
      INSERT INTO users(id,name,email,email_verified) VALUES ('user_owner','','${OWNER}',1);
      ${draft('fresh', new Date(atHour(10)).toISOString())}
      ${draft('waiting', SAVED)}
      ${draft('checkout', SAVED, 'paid')}
      ${draft('old', new Date(atHour(-24 * 31)).toISOString())}
    `)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function env() {
    return { D1_RUNTIME_ENV: 'local', DB: sqlite.asD1Database(), SITE_ENVIRONMENT: 'local' }
  }

  async function run(hours: number) {
    await handleScheduled({ cron: DRAFT_JOBS_CRON, scheduledTime: atHour(hours) }, env(), {
      waitUntil: promise => pending.push(promise)
    })
    await Promise.all(pending.splice(0))
  }

  function status(id: string) {
    return sqlite.database
      .prepare(
        'SELECT status,withdrawal_reason,draft_reminders_sent FROM listing_submissions WHERE id=?'
      )
      .get(id)
  }

  it('declares the same crons in every wrangler environment as the jobs they run', () => {
    const config = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../../wrangler.jsonc'), 'utf8')
    ) as {
      env: Record<string, { triggers?: { crons?: string[] } }>
      triggers?: { crons?: string[] }
    }
    const expected = Object.keys(scheduledJobs).sort()
    expect(expected).toEqual([DRAFT_JOBS_CRON, BADGE_WEEKLY_CRON, BADGE_DAILY_CRON].sort())
    // The hourly trigger continues the badge program after its own draft job.
    expect(scheduledJobs[DRAFT_JOBS_CRON]).toEqual([draftJobs, badgeProgramJob])
    expect(scheduledJobs[BADGE_WEEKLY_CRON]).toEqual([badgeProgramJob])
    expect(scheduledJobs[BADGE_DAILY_CRON]).toEqual([badgeProgramJob])
    for (const crons of [
      config.triggers?.crons,
      config.env.staging?.triggers?.crons,
      config.env.production?.triggers?.crons
    ]) {
      expect([...(crons ?? [])].sort()).toEqual(expected)
    }
  })

  it('expires 30-day drafts and sends the due reminder of each draft, once', async () => {
    // Hourly: nothing is due an hour early, and the +12h reminder goes out on the hour it falls due.
    await run(11)
    expect(status('waiting')).toMatchObject({ draft_reminders_sent: 0, status: 'draft' })
    await run(12)

    expect(status('old')).toEqual({
      draft_reminders_sent: 0,
      status: 'withdrawn',
      withdrawal_reason: 'expired'
    })
    expect(status('waiting')).toMatchObject({ draft_reminders_sent: 1, status: 'draft' })
    expect(status('checkout')).toMatchObject({ draft_reminders_sent: 1, status: 'draft' })
    // Saved three hours ago: nothing is due yet.
    expect(status('fresh')).toMatchObject({ draft_reminders_sent: 0, status: 'draft' })

    const subjects = readDevEmailOutbox(OWNER)
      .map(message => message.subject)
      .sort()
    expect(subjects).toEqual([
      'Finish your submission: Checkout',
      'Finish your submission: Waiting',
      'Your Old draft expired'
    ])
    // The paid listing is off (`features.showPaidListings`): no price, and a draft left in
    // checkout is sent to the plan choice.
    const checkout = readDevEmailOutbox(OWNER).find(message => message.subject.endsWith('Checkout'))
    expect(checkout?.text).toContain('/submit/checkout/choose/')
    for (const message of readDevEmailOutbox(OWNER)) {
      expect(message.text, message.subject).not.toMatch(/\$49|one-off|Complete checkout/u)
    }
    const waiting = readDevEmailOutbox(OWNER).find(message => message.subject.endsWith('Waiting'))
    expect(waiting?.text).toContain('/submit/waiting/choose/')
    expect(waiting?.text).toContain('expires in 30 days')

    // The same run again (an overlapping or retried trigger) claims and sends nothing new.
    await run(12)
    await run(13)
    expect(readDevEmailOutbox(OWNER)).toHaveLength(3)

    // The +21d reminder is the last one; the draft then expires at +30d.
    await run(21 * 24)
    expect(
      readDevEmailOutbox(OWNER).some(message =>
        message.subject.startsWith('Last reminder: your Waiting draft expires in 9 days')
      )
    ).toBe(true)
    await run(30 * 24)
    expect(status('waiting')).toMatchObject({ status: 'withdrawn', withdrawal_reason: 'expired' })
    expect(
      readDevEmailOutbox(OWNER).filter(message => message.subject === 'Your Waiting draft expired')
    ).toHaveLength(1)
  })

  it('ignores an unknown trigger and fails closed without a database', async () => {
    const job: ScheduledJob = { name: 'never', run: vi.fn(async () => ({})) }
    await handleScheduled(
      { cron: '* * * * *', scheduledTime: atHour(1) },
      env(),
      { waitUntil: () => undefined },
      { [DRAFT_JOBS_CRON]: [job] }
    )
    expect(job.run).not.toHaveBeenCalled()

    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await expect(
      handleScheduled(
        { cron: DRAFT_JOBS_CRON, scheduledTime: atHour(13) },
        { D1_RUNTIME_ENV: 'local', SITE_ENVIRONMENT: 'local' },
        { waitUntil: () => undefined }
      )
    ).rejects.toThrow(/scheduled job\(s\) failed/u)
    expect(String(errors.mock.calls[0]?.[0])).toContain('D1 binding DB is required')
  })

  it('runs every job of a trigger even when one fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const second: ScheduledJob = { name: 'second', run: vi.fn(async () => ({ done: true })) }
    await expect(
      handleScheduled(
        { cron: DRAFT_JOBS_CRON, scheduledTime: atHour(1) },
        env(),
        { waitUntil: () => undefined },
        {
          [DRAFT_JOBS_CRON]: [
            {
              name: 'first',
              run: async () => {
                throw new Error('boom')
              }
            },
            second
          ]
        }
      )
    ).rejects.toThrow(AggregateError)
    expect(second.run).toHaveBeenCalledOnce()
  })
})

/** Monday 2026-10-05 03:15 UTC (the weekly trigger) and Tuesday 03:45 UTC (the daily one). */
const WEEKLY_AT = Date.parse('2026-10-05T03:15:00.000Z')
const DAILY_AT = Date.parse('2026-10-06T03:45:00.000Z')
const FREE_OWNER = 'maker@free.example'
const CLAIM_OWNER = 'maker@claim.example'

describe('scheduled badge program', () => {
  let sqlite: SqliteD1
  let pending: Promise<unknown>[]
  /** What each fixture site serves: its badge, or an outage. */
  let sites: Record<string, 'down' | 'missing' | 'valid'>
  let fetches: string[]

  function page(host: string): string {
    const targets = submissionBadgeVerificationTargets(host)
    const badge =
      sites[host] === 'valid'
        ? `<a href="${targets.listingUrl}"><img src="${targets.badgeUrls[0]}" alt="Featured on SERP"></a>`
        : ''
    return `<!doctype html><html><head><title>${host}</title></head><body>${badge}</body></html>`
  }

  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    clearDevEmailOutbox()
    pending = []
    fetches = []
    sites = { 'claim.example': 'missing', 'curated.example': 'missing', 'free.example': 'missing' }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const host = new URL(String(input)).hostname
        fetches.push(host)
        if (sites[host] === 'down') throw new TypeError('fetch failed')
        return new Response(page(host), {
          headers: { 'content-type': 'text/html; charset=utf-8' },
          status: 200
        })
      })
    )
    sqlite = new SqliteD1()
    sqlite.database.exec(`
      INSERT INTO categories (slug, name, description, sort_order, is_active)
        VALUES ('tools', 'Tools', 'Tools', 0, 1);
      INSERT INTO publication_state (id, version, checksum, published_at)
        VALUES (1, 1, 'before', '2026-01-01T00:00:00.000Z');
      INSERT INTO users (id, name, email, email_verified) VALUES
        ('user_free', '', '${FREE_OWNER}', 1), ('user_claim', '', '${CLAIM_OWNER}', 1);
    `)
    for (const [id, slug, source] of [
      ['lst_free', 'free.example', 'submission'],
      ['lst_claim', 'claim.example', 'admin'],
      ['lst_curated', 'curated.example', 'admin']
    ] as const) {
      sqlite.database.exec(`
        INSERT INTO listings (id, slug, name, description, website, status, source_kind,
          source_identity, checksum, source)
        VALUES ('${id}', '${slug}', 'Name ${slug}', 'd', 'https://${slug}/', 'draft', 'fixture',
          '${id}', 'c-${id}', '${source}');
        INSERT INTO listing_categories VALUES ('${id}', 1, 0, 1);
        UPDATE listings SET status = 'approved', published_at = '2026-05-16' WHERE id = '${id}';
      `)
    }
    sqlite.database.exec(`
      INSERT INTO listing_submissions (id,slug,name,description,website,content,category_slug,
        logo_url,status,plan,listing_id,owner_user_id)
      VALUES ('sub_free','free.example','Name free.example','d','https://free.example/','c',
        'tools','l','approved','free','lst_free','user_free');
      INSERT INTO listing_owners (listing_id,user_id,verified_via,verified_at) VALUES
        ('lst_free','user_free','submission','2026-09-01T00:00:00.000Z'),
        ('lst_claim','user_claim','badge_claim','2026-09-01T00:00:00.000Z');
    `)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function env(overrides: Record<string, string> = {}) {
    return {
      D1_RUNTIME_ENV: 'local',
      DB: sqlite.asD1Database(),
      LOCAL_BADGE_PROGRAM: 'on',
      SITE_ENVIRONMENT: 'local',
      ...overrides
    }
  }

  async function trigger(cron: string, scheduledTime: number, overrides?: Record<string, string>) {
    await handleScheduled({ cron, scheduledTime }, env(overrides), {
      waitUntil: promise => pending.push(promise)
    })
    await Promise.all(pending.splice(0))
  }

  const rows = (sql: string) => sqlite.database.prepare(sql).all()
  const subjects = (to: string) =>
    readDevEmailOutbox(to)
      .map(message => message.subject)
      .sort()

  it('does nothing while the badge program is off', async () => {
    const off: SiteFeatures = {
      accountDashboard: false,
      badgeProgram: false,
      claims: false,
      listingFaqs: false,
      messages: false,
      orders: false
    }
    expect(badgeProgramEnabled(env({ LOCAL_BADGE_PROGRAM: '' }), off)).toBe(false)
    expect(badgeProgramEnabled(env(), off)).toBe(true)
    expect(badgeProgramEnabled(env(), { ...off, badgeProgram: true })).toBe(true)
    // The local switch never applies outside a local Worker.
    for (const environment of ['staging', 'production']) {
      expect(
        badgeProgramEnabled(
          env({ D1_RUNTIME_ENV: environment, SITE_ENVIRONMENT: environment }),
          off
        )
      ).toBe(false)
    }
    expect(badgeProgramEnabled(env({ SITE_ENVIRONMENT: 'production' }), off)).toBe(false)

    const job = createBadgeProgramJob(off)
    await handleScheduled(
      { cron: BADGE_WEEKLY_CRON, scheduledTime: WEEKLY_AT },
      env({ LOCAL_BADGE_PROGRAM: 'off' }),
      { waitUntil: promise => pending.push(promise) },
      { [BADGE_WEEKLY_CRON]: [job] }
    )
    await expect(
      job.run({
        context: { waitUntil: () => undefined },
        env: env({ LOCAL_BADGE_PROGRAM: 'off' }),
        now: new Date(WEEKLY_AT)
      })
    ).resolves.toEqual({ enabled: false })
    expect(fetches).toEqual([])
    expect(rows('SELECT * FROM badge_checks')).toEqual([])
  })

  it('warns on the weekly miss, then unpublishes or revokes on the confirmed miss, once', async () => {
    await trigger(BADGE_WEEKLY_CRON, WEEKLY_AT)
    // Never an admin listing without a badge claim.
    expect(fetches.sort()).toEqual(['claim.example', 'free.example'])
    expect(subjects(FREE_OWNER)).toEqual([
      'Action needed: the SERP badge is missing on free.example'
    ])
    expect(subjects(CLAIM_OWNER)).toEqual([
      'Action needed: the SERP badge is missing on claim.example'
    ])
    // The email names the recheck: Tuesday's daily window.
    expect(readDevEmailOutbox(FREE_OWNER)[0]?.text).toMatch(/check again around .*Oct 6/u)

    // The same trigger again, and the hourly continuation, find nothing new to check or send.
    await trigger(BADGE_WEEKLY_CRON, WEEKLY_AT)
    await trigger(DRAFT_JOBS_CRON, WEEKLY_AT + 45 * 60 * 1000)
    expect(fetches).toHaveLength(2)
    expect(readDevEmailOutbox(FREE_OWNER)).toHaveLength(1)

    await trigger(BADGE_DAILY_CRON, DAILY_AT)
    expect(subjects(FREE_OWNER)).toEqual([
      'Action needed: the SERP badge is missing on free.example',
      'Name free.example has been removed from SERP'
    ])
    expect(subjects(CLAIM_OWNER)).toEqual([
      'Action needed: the SERP badge is missing on claim.example',
      'You no longer manage Name claim.example on SERP'
    ])
    expect(
      rows(
        "SELECT id, is_active FROM listings WHERE id IN ('lst_free','lst_claim','lst_curated') ORDER BY id"
      )
    ).toEqual([
      { id: 'lst_claim', is_active: 1 },
      { id: 'lst_curated', is_active: 1 },
      { id: 'lst_free', is_active: 0 }
    ])
    expect(
      rows("SELECT revoked_reason FROM listing_owners WHERE listing_id = 'lst_claim'")
    ).toEqual([{ revoked_reason: 'badge_removed' }])
    expect(rows('SELECT version FROM publication_state')).toEqual([{ version: 3 }])

    // Replays send nothing twice and unpublish nothing twice.
    await trigger(BADGE_DAILY_CRON, DAILY_AT)
    await trigger(DRAFT_JOBS_CRON, DAILY_AT + 15 * 60 * 1000)
    expect(readDevEmailOutbox(FREE_OWNER)).toHaveLength(2)
    expect(readDevEmailOutbox(CLAIM_OWNER)).toHaveLength(2)
    expect(rows('SELECT version FROM publication_state')).toEqual([{ version: 3 }])
    expect(
      rows(
        "SELECT kind, outcome, conclusive FROM badge_checks WHERE listing_id = 'lst_free' ORDER BY id"
      )
    ).toEqual([
      { conclusive: 1, kind: 'weekly', outcome: 'fail' },
      { conclusive: 1, kind: 'confirmation', outcome: 'fail' }
    ])
  })

  it('keeps a listing whose recheck passes or cannot load the page', async () => {
    await trigger(BADGE_WEEKLY_CRON, WEEKLY_AT)
    sites['free.example'] = 'valid'
    sites['claim.example'] = 'down'
    await trigger(BADGE_DAILY_CRON, DAILY_AT)
    expect(
      rows("SELECT id, is_active FROM listings WHERE id IN ('lst_free','lst_claim') ORDER BY id")
    ).toEqual([
      { id: 'lst_claim', is_active: 1 },
      { id: 'lst_free', is_active: 1 }
    ])
    expect(rows("SELECT revoked_at FROM listing_owners WHERE listing_id = 'lst_claim'")).toEqual([
      { revoked_at: null }
    ])
    expect(subjects(FREE_OWNER)).toHaveLength(1)
    expect(subjects(CLAIM_OWNER)).toHaveLength(1)
    // The inconclusive recheck is tried again the next day; the badge is back by then.
    sites['claim.example'] = 'valid'
    await trigger(BADGE_DAILY_CRON, DAILY_AT + 24 * 60 * 60 * 1000)
    expect(
      rows(
        "SELECT kind, outcome, reason, conclusive FROM badge_checks WHERE listing_id = 'lst_claim' ORDER BY id"
      )
    ).toEqual([
      { conclusive: 1, kind: 'weekly', outcome: 'fail', reason: 'badge_missing' },
      { conclusive: 0, kind: 'confirmation', outcome: 'fail', reason: 'site_unreachable' },
      { conclusive: 1, kind: 'confirmation', outcome: 'pass', reason: null }
    ])
    expect(rows('SELECT version FROM publication_state')).toEqual([{ version: 1 }])
  })
})

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SqliteD1 } from '../../../../packages/data-ops/src/test-support'
import { clearDevEmailOutbox, readDevEmailOutbox } from '../email/senders'
import { DRAFT_JOBS_CRON, handleScheduled, type ScheduledJob, scheduledJobs } from './scheduled'

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

  it('declares the same daily cron in every wrangler environment as the jobs it runs', () => {
    const config = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../../wrangler.jsonc'), 'utf8')
    ) as {
      env: Record<string, { triggers?: { crons?: string[] } }>
      triggers?: { crons?: string[] }
    }
    const expected = Object.keys(scheduledJobs).sort()
    expect(expected).toEqual([DRAFT_JOBS_CRON])
    for (const crons of [
      config.triggers?.crons,
      config.env.staging?.triggers?.crons,
      config.env.production?.triggers?.crons
    ]) {
      expect([...(crons ?? [])].sort()).toEqual(expected)
    }
  })

  it('expires 30-day drafts and sends the due reminder of each draft, once', async () => {
    await run(13)

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
    const checkout = readDevEmailOutbox(OWNER).find(message => message.subject.endsWith('Checkout'))
    expect(checkout?.text).toContain('/submit/checkout/checkout/')
    const waiting = readDevEmailOutbox(OWNER).find(message => message.subject.endsWith('Waiting'))
    expect(waiting?.text).toContain('/submit/waiting/choose/')
    expect(waiting?.text).toContain('expires in 30 days')

    // The same run again (an overlapping or retried trigger) claims and sends nothing new.
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
    ).rejects.toThrow(/1 scheduled job\(s\) failed/u)
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

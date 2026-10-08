import { createDatabase } from '@/db/client'
import { createDraftJobOperations } from '@/db/draft-jobs'
import { createEmailDeliveryLedger } from '@/db/email-deliveries'
import { beforeEach, describe, expect, it } from 'vitest'
import { SqliteD1 } from '@/db/test-support'
import { resolveEmailPolicy } from '../email/config'
import { appEmailTemplates } from '../email/registry'
import { createCapturingEmailSender } from '../email/senders'
import { createEmailService } from '../email/service'
import { runDraftJobs } from './draft-jobs'

const SAVED = '2026-09-01T00:00:00.000Z'
const HOUR = 60 * 60 * 1000
const ID = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'

function atHour(hours: number): Date {
  return new Date(Date.parse(SAVED) + hours * HOUR)
}

// PR #84 review round 1, finding 7: failed sends are retried; an outage fails the run.
describe('draft job retries', () => {
  let sqlite: SqliteD1
  let sender: ReturnType<typeof createCapturingEmailSender>
  let deliveries: Promise<unknown>[]

  beforeEach(() => {
    sqlite = new SqliteD1()
    sqlite.database.exec(`
      INSERT INTO users(id,name,email,email_verified) VALUES ('user_owner','','owner@example.com',1);
      INSERT INTO listing_submissions
        (id,slug,block_key,block_covers_subdomains,name,description,website,content,category_slug,
          logo_url,status,owner_user_id,plan,draft_saved_at)
      VALUES
        ('${ID}','one.example','one.example',1,'One','d','https://one.example/','','tools',
          'https://one.example/l.png','draft','user_owner',NULL,'${SAVED}'),
        ('${OTHER}','two.example','two.example',1,'Two','d','https://two.example/','','tools',
          'https://two.example/l.png','draft','user_owner',NULL,'${SAVED}');
    `)
    sender = createCapturingEmailSender()
    deliveries = []
  })

  function run(hours: number, binding: D1Database = sqlite.asD1Database()) {
    const client = createDatabase(binding)
    const email = createEmailService({
      ledger: createEmailDeliveryLedger({ client: createDatabase(sqlite.asD1Database()) }),
      log: () => undefined,
      policy: resolveEmailPolicy({ D1_RUNTIME_ENV: 'production', SITE_ENVIRONMENT: 'production' }),
      sender,
      templates: appEmailTemplates,
      waitUntil: promise => deliveries.push(promise)
    })
    return runDraftJobs({
      jobs: createDraftJobOperations({ client }),
      now: atHour(hours),
      paidListings: false,
      priceCents: 4900,
      async send(templateId, request) {
        email.enqueue(templateId, request)
        await Promise.allSettled(deliveries.splice(0))
      }
    })
  }

  function ledger() {
    return sqlite.database
      .prepare(
        'SELECT template_id,event_key,status,attempts FROM email_deliveries ORDER BY event_key'
      )
      .all()
  }

  it('sends one at a time and retries a failed send on the next run', async () => {
    sender.failNext(Object.assign(new Error('provider down'), { code: 'E_UNAVAILABLE' }))
    await expect(run(12)).resolves.toMatchObject({ reminded: 2, retried: 0 })
    expect(sender.sent.map(message => message.subject)).toEqual(['Finish your submission: Two'])
    expect(ledger()).toEqual([
      {
        attempts: 1,
        event_key: `submission-draft-reminder:${ID}:1`,
        status: 'failed',
        template_id: 'draft-reminder'
      },
      {
        attempts: 1,
        event_key: `submission-draft-reminder:${OTHER}:1`,
        status: 'sent',
        template_id: 'draft-reminder'
      }
    ])

    await expect(run(13)).resolves.toMatchObject({ reminded: 0, retried: 1 })
    expect(sender.sent.map(message => message.subject)).toEqual([
      'Finish your submission: Two',
      'Finish your submission: One'
    ])
    expect(ledger()).toMatchObject([{ attempts: 2, status: 'sent' }, { status: 'sent' }])

    // Sent now: nothing is retried again.
    await expect(run(14)).resolves.toMatchObject({ reminded: 0, retried: 0 })
    expect(sender.sent).toHaveLength(2)
  })

  it('does not retry a reminder that no longer describes the draft', async () => {
    sender.failNext(new Error('provider down'))
    await run(12)
    // The draft chose free (it left `draft`): the reminder would be wrong.
    sqlite.database
      .prepare("UPDATE listing_submissions SET status='pending_badge',plan='free' WHERE id=?")
      .run(ID)
    await expect(run(13)).resolves.toMatchObject({ retried: 0 })
    expect(sender.sent.map(message => message.subject)).toEqual(['Finish your submission: Two'])
  })

  it('stops retrying once the ledger has used up its attempts', async () => {
    // Two reminders, five attempts each, all failing.
    for (let attempt = 0; attempt < 10; attempt += 1) sender.failNext(new Error('down'))
    await run(12)
    for (let hour = 13; hour <= 16; hour += 1) await run(hour)
    expect(ledger()).toMatchObject([
      { attempts: 5, status: 'failed' },
      { attempts: 5, status: 'failed' }
    ])
    await expect(run(17)).resolves.toMatchObject({ retried: 0 })
    expect(sender.sent).toHaveLength(0)
  })

  it('retries a failed draft-expired email', async () => {
    sender.failNext(new Error('down'))
    sender.failNext(new Error('down'))
    await expect(run(30 * 24)).resolves.toMatchObject({ expired: 2 })
    expect(sender.sent).toHaveLength(0)
    await expect(run(30 * 24 + 1)).resolves.toMatchObject({ retried: 2 })
    expect(sender.sent.map(message => message.subject).sort()).toEqual([
      'Your One draft expired',
      'Your Two draft expired'
    ])
  })

  it('fails the run on a D1 outage instead of reporting nothing due', async () => {
    const real = sqlite.asD1Database()
    const broken = {
      batch: async () => {
        throw new Error('D1_ERROR: Network connection lost.')
      },
      prepare: (sql: string) => real.prepare(sql)
    } as unknown as D1Database
    await expect(run(12, broken)).rejects.toThrow(/D1 draft job claim failed/u)
    expect(sender.sent).toHaveLength(0)
  })
})

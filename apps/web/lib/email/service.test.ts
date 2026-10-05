import { createDatabase } from '@serpdirectory/data-ops/client'
import {
  createEmailDeliveryLedger,
  type EmailDeliveryLedger
} from '@serpdirectory/data-ops/email-deliveries'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SqliteD1 } from '../../../../packages/data-ops/src/test-support'
import { EMAIL_FROM, type EmailEnvironmentVars, resolveEmailPolicy } from './config'
import { createWorkerEmailService } from './runtime'
import { createCapturingEmailSender, type SendEmailBinding } from './senders'
import { createEmailService, type EmailLogEntry, emailEventKey } from './service'
import { fixtureTemplates } from './test-fixture'

const production: EmailEnvironmentVars = {
  D1_RUNTIME_ENV: 'production',
  SITE_ENVIRONMENT: 'production'
}
const staging: EmailEnvironmentVars = {
  D1_RUNTIME_ENV: 'staging',
  EMAIL_STAGING_ALLOWLIST: 'owner@serp.co',
  SITE_ENVIRONMENT: 'staging'
}
const local: EmailEnvironmentVars = { D1_RUNTIME_ENV: 'local', SITE_ENVIRONMENT: 'local' }

const input = { path: '/products/autoenhance.ai', title: 'Secret body text' }

function harness(
  vars: EmailEnvironmentVars,
  options: { ledger?: (real: EmailDeliveryLedger) => EmailDeliveryLedger } = {}
) {
  const d1 = new SqliteD1()
  const realLedger = createEmailDeliveryLedger({ client: createDatabase(d1.asD1Database()) })
  const sender = createCapturingEmailSender()
  const logs: EmailLogEntry[] = []
  const pending: Promise<unknown>[] = []
  const service = createEmailService({
    ledger: options.ledger ? options.ledger(realLedger) : realLedger,
    log: entry => logs.push(entry),
    policy: resolveEmailPolicy(vars),
    sender,
    templates: fixtureTemplates,
    waitUntil: promise => {
      pending.push(promise)
    }
  })
  const send = (eventKey: string, to = 'Owner@Serp.co') =>
    service.enqueue('test-fixture', { eventKey, input, to })
  const settle = async () => {
    await Promise.all(pending.splice(0))
  }
  const rows = () => d1.database.prepare('SELECT * FROM email_deliveries ORDER BY event_key').all()
  const events = () => logs.map(entry => entry.event)
  return { events, logs, pending, rows, send, sender, settle }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('email delivery', () => {
  it('sends after the response, through waitUntil, with absolute production links', async () => {
    const { logs, pending, send, sender, settle } = harness(production)
    send('fixture:delivery')
    expect(pending).toHaveLength(1)
    expect(sender.sent).toHaveLength(0)
    await settle()
    expect(sender.sent).toEqual([
      {
        from: EMAIL_FROM,
        headers: { 'Auto-Submitted': 'auto-generated' },
        html: '<p>Secret body text</p><p><a href="https://best.serp.co/products/autoenhance.ai/">https://best.serp.co/products/autoenhance.ai/</a></p><p>support@serp.co</p>',
        subject: 'Fixture: Secret body text',
        text: 'Secret body text\n\nhttps://best.serp.co/products/autoenhance.ai/\n\nsupport@serp.co',
        to: 'owner@serp.co'
      }
    ])
    expect(logs).toEqual([
      {
        attempt: 1,
        environment: 'production',
        event: 'email_sent',
        eventKey: 'fixture:delivery',
        level: 'info',
        messageId: 'capture-1',
        provider: 'capture',
        recipientDomain: 'serp.co',
        templateId: 'test-fixture'
      }
    ])
  })

  it('prefixes staging subjects, links to staging, and sends only to the allowlist', async () => {
    const { logs, rows, send, sender, settle } = harness(staging)
    send('fixture:allowed')
    send('fixture:blocked', 'someone@example.com')
    await settle()
    expect(sender.sent).toHaveLength(1)
    expect(sender.sent[0]?.subject).toBe('[staging] Fixture: Secret body text')
    expect(sender.sent[0]?.text).toContain(
      'https://best-serp-co-staging.serpcompany.workers.dev/products/autoenhance.ai/'
    )
    expect(sender.sent[0]?.to).toBe('owner@serp.co')
    expect(logs.find(entry => entry.event === 'email_skipped')).toMatchObject({
      eventKey: 'fixture:blocked',
      level: 'warn',
      reason: 'recipient_not_allowed',
      recipientDomain: 'example.com'
    })
    // A skipped recipient is never claimed, so it does not use up the event key.
    expect(rows().map(row => row.event_key)).toEqual(['fixture:allowed'])
  })

  it('never sends one event key twice', async () => {
    const { events, logs, rows, send, sender, settle } = harness(production)
    send('fixture:once')
    send('fixture:once')
    await settle()
    send('fixture:once')
    await settle()
    expect(sender.sent).toHaveLength(1)
    expect(events()).toEqual([
      'email_sent',
      'email_duplicate_suppressed',
      'email_duplicate_suppressed'
    ])
    expect(logs[1]).toMatchObject({ status: 'sending' })
    expect(logs[2]).toMatchObject({ attempts: 1, status: 'sent' })
    send('fixture:other')
    await settle()
    expect(sender.sent).toHaveLength(2)
    expect(rows().map(row => [row.event_key, row.status])).toEqual([
      ['fixture:once', 'sent'],
      ['fixture:other', 'sent']
    ])
  })

  it('logs a failed send without failing the caller, and lets the same event retry', async () => {
    const { logs, rows, send, sender, settle } = harness(production)
    sender.failNext(
      Object.assign(new Error('Rate limit hit for owner@serp.co'), {
        code: 'E_RATE_LIMIT_EXCEEDED'
      })
    )
    expect(() => send('fixture:retry')).not.toThrow()
    await settle()
    expect(sender.sent).toHaveLength(0)
    expect(logs).toEqual([
      expect.objectContaining({
        error: 'Rate limit hit for [redacted]',
        errorCode: 'E_RATE_LIMIT_EXCEEDED',
        event: 'email_send_failed',
        level: 'error'
      })
    ])
    expect(rows()[0]).toMatchObject({ last_error_code: 'E_RATE_LIMIT_EXCEEDED', status: 'failed' })

    send('fixture:retry')
    await settle()
    expect(sender.sent).toHaveLength(1)
    expect(logs.at(-1)).toMatchObject({ attempt: 2, event: 'email_sent' })
    expect(rows()[0]).toMatchObject({ attempts: 2, status: 'sent' })
  })

  it('sends nothing when the ledger cannot claim the event', async () => {
    const { logs, send, sender, settle } = harness(production, {
      ledger: real => ({
        ...real,
        claim: async () => {
          throw new Error('D1_ERROR: no such table: email_deliveries')
        }
      })
    })
    send('fixture:no-ledger')
    await settle()
    expect(sender.sent).toHaveLength(0)
    expect(logs).toEqual([
      expect.objectContaining({ event: 'email_ledger_failed', level: 'error', stage: 'claim' })
    ])
  })

  it('does not resend an email whose outcome could not be recorded', async () => {
    let failCompletion = true
    const { events, send, sender, settle } = harness(production, {
      ledger: real => ({
        claim: input => real.claim(input),
        complete: async completion => {
          if (failCompletion) throw new Error('D1 unavailable')
          return real.complete(completion)
        }
      })
    })
    send('fixture:unrecorded')
    await settle()
    failCompletion = false
    send('fixture:unrecorded')
    await settle()
    expect(sender.sent).toHaveLength(1)
    expect(events()).toEqual(['email_sent', 'email_ledger_failed', 'email_duplicate_suppressed'])
  })

  it('rejects malformed requests in the background without throwing', async () => {
    const { logs, rows, send, sender, settle } = harness(production)
    expect(() => send('person@example.com')).not.toThrow()
    expect(() => send('fixture:bad-recipient', 'a@b.co, c@d.co')).not.toThrow()
    send('fixture:valid')
    await settle()
    expect(logs.map(entry => [entry.event, entry.reason])).toEqual([
      ['email_rejected', 'invalid_event_key'],
      ['email_rejected', 'invalid_recipient'],
      ['email_sent', undefined]
    ])
    expect(sender.sent).toHaveLength(1)
    expect(rows()).toHaveLength(1)
  })

  it('logs a render failure and an unknown template without claiming the event', async () => {
    const d1 = new SqliteD1()
    const logs: EmailLogEntry[] = []
    const pending: Promise<unknown>[] = []
    const sender = createCapturingEmailSender()
    const service = createEmailService({
      ledger: createEmailDeliveryLedger({ client: createDatabase(d1.asD1Database()) }),
      log: entry => logs.push(entry),
      policy: resolveEmailPolicy(production),
      sender,
      templates: fixtureTemplates,
      waitUntil: promise => {
        pending.push(promise)
      }
    })
    service.enqueue('test-fixture', {
      eventKey: 'fixture:render',
      input: { path: 'https://evil.example/', title: 'x' },
      to: 'owner@serp.co'
    })
    ;(service.enqueue as (id: string, request: unknown) => void)('missing-template', {
      eventKey: 'fixture:missing',
      input: {},
      to: 'owner@serp.co'
    })
    await Promise.all(pending)
    expect(logs.map(entry => [entry.event, entry.reason])).toEqual([
      ['email_render_failed', undefined],
      ['email_rejected', 'unknown_template']
    ])
    expect(sender.sent).toHaveLength(0)
    expect(d1.database.prepare('SELECT count(*) AS n FROM email_deliveries').get()).toEqual({
      n: 0
    })
  })

  it('logs when waitUntil is unavailable instead of throwing', () => {
    const logs: EmailLogEntry[] = []
    const service = createEmailService({
      ledger: createEmailDeliveryLedger({
        client: createDatabase(new SqliteD1().asD1Database())
      }),
      log: entry => logs.push(entry),
      policy: resolveEmailPolicy(production),
      sender: createCapturingEmailSender(),
      templates: fixtureTemplates,
      waitUntil: () => {
        throw new Error('no execution context')
      }
    })
    expect(() =>
      service.enqueue('test-fixture', { eventKey: 'fixture:ctx', input, to: 'owner@serp.co' })
    ).not.toThrow()
    expect(logs[0]).toMatchObject({ event: 'email_wait_until_failed', level: 'error' })
  })

  it('keeps addresses and bodies out of deployed logs', async () => {
    const { logs, send, sender, settle } = harness(staging)
    sender.failNext(new Error('E: owner@serp.co bounced'))
    send('fixture:private-1')
    send('fixture:private-2')
    send('fixture:private-3', 'stranger@example.com')
    await settle()
    const serialized = JSON.stringify(logs)
    expect(serialized).not.toMatch(/owner@serp\.co|stranger@example\.com|Secret body text/u)
  })
})

describe('Worker email service', () => {
  function binding() {
    const calls: unknown[] = []
    const email: SendEmailBinding = {
      send: async message => {
        calls.push(message)
        return { messageId: `cf-${calls.length}` }
      }
    }
    return { calls, email }
  }

  async function run(
    env: Parameters<typeof createWorkerEmailService>[0]['env'],
    to = 'owner@serp.co'
  ) {
    const logs: EmailLogEntry[] = []
    const pending: Promise<unknown>[] = []
    createWorkerEmailService({
      context: { waitUntil: promise => pending.push(promise) },
      env,
      log: entry => logs.push(entry),
      templates: fixtureTemplates
    }).enqueue('test-fixture', { eventKey: 'fixture:worker', input, to })
    await Promise.all(pending)
    return logs
  }

  it('sends through the EMAIL binding in staging and production', async () => {
    for (const vars of [staging, production]) {
      const { calls, email } = binding()
      const logs = await run({ ...vars, DB: new SqliteD1().asD1Database(), EMAIL: email })
      expect(calls).toEqual([
        {
          from: { email: 'noreply@mail.serp.co', name: 'SERP Directory' },
          headers: { 'Auto-Submitted': 'auto-generated' },
          html: expect.stringContaining('/products/autoenhance.ai/'),
          subject:
            vars === staging ? '[staging] Fixture: Secret body text' : 'Fixture: Secret body text',
          text: expect.stringContaining('/products/autoenhance.ai/'),
          to: 'owner@serp.co'
        }
      ])
      expect(logs).toEqual([
        expect.objectContaining({ event: 'email_sent', messageId: 'cf-1', provider: 'cloudflare' })
      ])
    }
  })

  it('writes local mail to the log and never calls a binding', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const { calls, email } = binding()
    const logs = await run({ ...local, DB: new SqliteD1().asD1Database(), EMAIL: email })
    expect(calls).toEqual([])
    expect(logs).toEqual([expect.objectContaining({ event: 'email_sent', provider: 'log' })])
    const logged = JSON.parse(String(info.mock.calls[0]?.[0])) as Record<string, unknown>
    expect(logged).toMatchObject({
      event: 'email_logged',
      subject: 'Fixture: Secret body text',
      text: 'Secret body text\n\nhttp://localhost:8787/products/autoenhance.ai/\n\nsupport@serp.co',
      to: 'owner@serp.co'
    })
  })

  it('fails closed without a valid environment or the bindings it needs', async () => {
    const DB = new SqliteD1().asD1Database()
    const cases = [
      { DB },
      { ...production, DB, SITE_ENVIRONMENT: 'prod' },
      { ...production, D1_RUNTIME_ENV: 'staging', DB },
      { ...staging, DB: undefined },
      { ...staging, DB, withoutBinding: true },
      { ...production, DB, withoutBinding: true }
    ]
    for (const { withoutBinding, ...vars } of cases) {
      const { calls, email } = binding()
      const logs = await run({ ...vars, EMAIL: withoutBinding ? undefined : email })
      expect(logs, JSON.stringify(vars)).toEqual([
        expect.objectContaining({ event: 'email_disabled', level: 'error' })
      ])
      expect(calls).toEqual([])
    }
  })
})

describe('email event keys', () => {
  it('joins an event name and ids, and refuses anything that could hold an address', () => {
    expect(emailEventKey('submission-received', '0b7c2d9e-1f4a-4c3b-9a8e-123456789abc')).toBe(
      'submission-received:0b7c2d9e-1f4a-4c3b-9a8e-123456789abc'
    )
    expect(emailEventKey('badge-missing', 'lst_abc123', '2026-10-06')).toBe(
      'badge-missing:lst_abc123:2026-10-06'
    )
    for (const parts of [
      ['sign-in-code'],
      ['sign-in-code', 'person@example.com'],
      ['Upper', 'id'],
      ['event', 'has space'],
      ['event', 'a:b'],
      ['event', 'x'.repeat(200)]
    ]) {
      expect(() => emailEventKey(parts[0] as string, ...parts.slice(1)), parts.join('|')).toThrow()
    }
  })
})

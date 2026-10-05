import { createDatabase } from '@serpdirectory/data-ops/client'
import {
  createEmailDeliveryLedger,
  EMAIL_DELIVERY_MAX_ATTEMPTS,
  type EmailDeliveryLedger
} from '@serpdirectory/data-ops/email-deliveries'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SqliteD1 } from '../../../../packages/data-ops/src/test-support'
import { EMAIL_FROM, type EmailEnvironmentVars, resolveEmailPolicy } from './config'
import { createWorkerEmailService } from './runtime'
import { createCapturingEmailSender, type SendEmailBinding } from './senders'
import {
  createDisabledEmailService,
  createEmailService,
  type EmailLogEntry,
  emailEventKey
} from './service'
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
  options: {
    ledger?: (real: EmailDeliveryLedger) => EmailDeliveryLedger
    waitUntil?: (promise: Promise<unknown>) => void
  } = {}
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
    waitUntil:
      options.waitUntil ??
      (promise => {
        pending.push(promise)
      })
  })
  const send = (eventKey: string, to = 'Owner@Serp.co') =>
    service.enqueue('test-fixture', { eventKey, input, to })
  const settle = async () => {
    await Promise.all(pending.splice(0))
  }
  const rows = () =>
    d1.database.prepare('SELECT * FROM email_deliveries ORDER BY template_id, event_key').all()
  const events = () => logs.map(entry => entry.event)
  return { events, logs, pending, rows, send, sender, service, settle }
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
        replyTo: 'support@serp.co',
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

  it('never sends one template and event key twice', async () => {
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
    expect(logs[1]).toMatchObject({ level: 'info', status: 'sending' })
    expect(logs[2]).toMatchObject({ attempts: 1, level: 'info', status: 'sent' })
    send('fixture:other')
    await settle()
    expect(sender.sent).toHaveLength(2)
    expect(rows().map(row => [row.event_key, row.status])).toEqual([
      ['fixture:once', 'sent'],
      ['fixture:other', 'sent']
    ])
  })

  it('sends each template once for the same event', async () => {
    const { send, sender, service, settle } = harness(production)
    const eventKey = emailEventKey('submission-created', 'sub-1')
    send(eventKey)
    service.enqueue('test-fixture-notice', { eventKey, input, to: 'admin@serp.co' })
    service.enqueue('test-fixture-notice', { eventKey, input, to: 'admin@serp.co' })
    await settle()
    expect(sender.sent.map(message => [message.subject, message.to])).toEqual([
      ['Fixture: Secret body text', 'owner@serp.co'],
      ['Notice: Secret body text', 'admin@serp.co']
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

  it('treats a failed duplicate below the limit as a duplicate, not exhaustion', async () => {
    const { logs, send, sender, settle } = harness(production, {
      ledger: real => ({
        ...real,
        claim: async () => ({
          attempts: 2,
          exhausted: false,
          outcome: 'duplicate',
          status: 'failed'
        })
      })
    })
    send('fixture:race')
    await settle()
    expect(sender.sent).toHaveLength(0)
    expect(logs).toEqual([
      expect.objectContaining({
        attempts: 2,
        event: 'email_duplicate_suppressed',
        level: 'info',
        status: 'failed'
      })
    ])
  })

  it('sends every code email keyed per call, with the code only in the message', async () => {
    const { logs, rows, sender, service, settle } = harness(production)
    const code = { path: '/login', title: '482913' }
    for (let call = 0; call < 2; call++) {
      service.enqueue('test-fixture', {
        eventKey: emailEventKey('sign-in-code', crypto.randomUUID()),
        input: code,
        to: 'owner@serp.co'
      })
    }
    await settle()
    expect(sender.sent.map(message => message.subject)).toEqual([
      'Fixture: 482913',
      'Fixture: 482913'
    ])
    expect(new Set(rows().map(row => row.event_key)).size).toBe(2)
    expect(JSON.stringify(logs)).not.toContain('482913')
    expect(JSON.stringify(rows())).not.toContain('482913')
  })

  it('warns once an event has used up its attempts', async () => {
    const { events, logs, send, sender, settle } = harness(production)
    for (let attempt = 1; attempt <= EMAIL_DELIVERY_MAX_ATTEMPTS; attempt++) {
      sender.failNext(Object.assign(new Error('quota'), { code: 'E_DAILY_LIMIT_EXCEEDED' }))
      send('fixture:quota')
      await settle()
    }
    send('fixture:quota')
    await settle()
    expect(sender.sent).toHaveLength(0)
    expect(events()).toEqual([
      ...Array.from({ length: EMAIL_DELIVERY_MAX_ATTEMPTS }, () => 'email_send_failed'),
      'email_attempts_exhausted'
    ])
    expect(logs.at(-1)).toMatchObject({ attempts: EMAIL_DELIVERY_MAX_ATTEMPTS, level: 'warn' })
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
        claim: claim => real.claim(claim),
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
    expect(logs.map(entry => [entry.event, entry.reason, entry.eventKey])).toEqual([
      ['email_rejected', 'invalid_event_key', '[invalid]'],
      ['email_rejected', 'invalid_recipient', 'fixture:bad-recipient'],
      ['email_sent', undefined, 'fixture:valid']
    ])
    expect(sender.sent).toHaveLength(1)
    expect(rows()).toHaveLength(1)
  })

  it('logs a render failure and an unknown template without claiming the event', async () => {
    const { logs, rows, sender, service, settle } = harness(production)
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
    await settle()
    expect(logs.map(entry => [entry.event, entry.reason])).toEqual([
      ['email_render_failed', undefined],
      ['email_rejected', 'unknown_template']
    ])
    expect(sender.sent).toHaveLength(0)
    expect(rows()).toHaveLength(0)
  })

  it('logs when waitUntil is unavailable instead of throwing', () => {
    const { logs, service } = harness(production, {
      waitUntil: () => {
        throw new Error('no execution context')
      }
    })
    expect(() =>
      service.enqueue('test-fixture', { eventKey: 'fixture:ctx', input, to: 'owner@serp.co' })
    ).not.toThrow()
    expect(logs[0]).toMatchObject({ event: 'email_wait_until_failed', level: 'error' })
  })
})

describe('email logs', () => {
  // Recipient domains are allowed; local parts, full addresses, and bodies are not.
  const address = /@|person|owner|stranger|Secret body text/iu

  it('never carry an address, a body, or an unvalidated key on any path', async () => {
    const logs: EmailLogEntry[] = []
    const collect = (entry: EmailLogEntry) => logs.push(entry)

    // Delivery paths, including a send failure that names the recipient.
    const deployed = harness(staging)
    deployed.sender.failNext(new Error('E: owner@serp.co bounced'))
    deployed.send('fixture:private-1')
    deployed.send('fixture:private-2')
    deployed.send('fixture:private-3', 'stranger@example.com')
    // An address passed as the event key or the template id.
    deployed.send('sign-in-code:Person@Example.com')
    ;(deployed.service.enqueue as (id: string, request: unknown) => void)('person@example.com', {
      eventKey: 'fixture:x',
      input,
      to: 'owner@serp.co'
    })
    // An unexpected throw inside delivery whose message holds an address.
    deployed.service.enqueue('test-fixture', {
      eventKey: 'otp:person@example.com',
      input,
      get to(): string {
        throw new Error('getter failed for person@example.com')
      }
    })
    deployed.service.enqueue('test-fixture', {
      eventKey: 'fixture:getter',
      input,
      get to(): string {
        throw new Error('getter failed for person@example.com')
      }
    })
    await deployed.settle()
    logs.push(...deployed.logs)

    // waitUntil failing with an address in its message and the key.
    const noContext = harness(production, {
      waitUntil: () => {
        throw new Error('no context for owner@serp.co')
      }
    })
    noContext.send('otp:owner@serp.co')
    logs.push(...noContext.logs)

    // The disabled service, with an address in the key and in the reason.
    createDisabledEmailService<typeof fixtureTemplates>(
      'Email is disabled: config for person@example.com',
      collect
    ).enqueue('test-fixture', { eventKey: 'otp:person@example.com', input, to: 'a@b.co' })

    const events = logs.map(entry => entry.event)
    for (const event of [
      'email_send_failed',
      'email_sent',
      'email_skipped',
      'email_rejected',
      'email_delivery_failed',
      'email_wait_until_failed',
      'email_disabled'
    ]) {
      expect(events, event).toContain(event)
    }
    for (const entry of logs) {
      expect(JSON.stringify(entry), entry.event).not.toMatch(address)
    }
    expect(logs.filter(entry => entry.eventKey === '[invalid]').length).toBeGreaterThanOrEqual(4)
    expect(logs.find(entry => entry.event === 'email_delivery_failed')).toMatchObject({
      error: 'getter failed for [redacted]',
      eventKey: 'fixture:getter'
    })
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

  it('sends through the EMAIL binding in staging and production, replying to support', async () => {
    for (const vars of [staging, production]) {
      const { calls, email } = binding()
      const logs = await run({ ...vars, DB: new SqliteD1().asD1Database(), EMAIL: email })
      expect(calls).toEqual([
        {
          from: { email: 'noreply@mail.serp.co', name: 'SERP Directory' },
          headers: { 'Auto-Submitted': 'auto-generated' },
          html: expect.stringContaining('/products/autoenhance.ai/'),
          replyTo: 'support@serp.co',
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
      replyTo: 'support@serp.co',
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
      { ...staging, DB, EMAIL_STAGING_ALLOWLIST: 'not an address' },
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
  it('accepts a per-call random UUID for code emails', () => {
    const first = emailEventKey('sign-in-code', crypto.randomUUID())
    const second = emailEventKey('sign-in-code', crypto.randomUUID())
    expect(first).toMatch(/^sign-in-code:[0-9a-f-]{36}$/u)
    expect(second).not.toBe(first)
  })

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

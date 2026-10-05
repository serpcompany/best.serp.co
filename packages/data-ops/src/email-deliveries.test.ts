import { describe, expect, it } from 'vitest'
import { createDatabase } from './client'
import {
  createEmailDeliveryLedger,
  EMAIL_DELIVERY_MAX_ATTEMPTS,
  isEmailEventKey
} from './email-deliveries'
import { SqliteD1 } from './test-support'

function ledger() {
  const d1 = new SqliteD1()
  let tick = 0
  const operations = createEmailDeliveryLedger({
    client: createDatabase(d1.asD1Database()),
    clock: () => new Date(Date.UTC(2026, 9, 6, 12, 0, tick++))
  })
  const row = (eventKey: string) =>
    d1.database.prepare('SELECT * FROM email_deliveries WHERE event_key = ?').get(eventKey) as
      | Record<string, unknown>
      | undefined
  return { d1, operations, row }
}

const claim = { eventKey: 'fixture:event-1', provider: 'cloudflare', templateId: 'fixture' }

describe('email delivery ledger', () => {
  it('claims an event key once; a second claim is a duplicate of the in-flight send', async () => {
    const { operations, row } = ledger()
    expect(await operations.claim(claim)).toEqual({ attempt: 1, outcome: 'claimed' })
    expect(await operations.claim(claim)).toEqual({
      attempts: 1,
      outcome: 'duplicate',
      status: 'sending',
      templateId: 'fixture'
    })
    expect(row(claim.eventKey)).toMatchObject({
      attempts: 1,
      created_at: '2026-10-06T12:00:00.000Z',
      provider: 'cloudflare',
      status: 'sending',
      template_id: 'fixture'
    })
  })

  it('never re-claims a sent event and records the provider message id', async () => {
    const { operations, row } = ledger()
    await operations.claim(claim)
    expect(
      await operations.complete({
        attempt: 1,
        eventKey: claim.eventKey,
        providerMessageId: 'msg-1',
        status: 'sent'
      })
    ).toBe(true)
    expect(await operations.claim(claim)).toMatchObject({ outcome: 'duplicate', status: 'sent' })
    expect(row(claim.eventKey)).toMatchObject({
      last_error_code: null,
      provider_message_id: 'msg-1',
      status: 'sent'
    })
  })

  it('re-claims a failed event for another attempt, up to the attempt limit', async () => {
    const { operations, row } = ledger()
    for (let attempt = 1; attempt <= EMAIL_DELIVERY_MAX_ATTEMPTS; attempt++) {
      expect(await operations.claim(claim)).toEqual({ attempt, outcome: 'claimed' })
      expect(row(claim.eventKey)).toMatchObject({ last_error_code: null, status: 'sending' })
      await operations.complete({
        attempt,
        errorCode: 'E_RATE_LIMIT_EXCEEDED',
        eventKey: claim.eventKey,
        status: 'failed'
      })
      expect(row(claim.eventKey)).toMatchObject({
        last_error_code: 'E_RATE_LIMIT_EXCEEDED',
        status: 'failed'
      })
    }
    expect(await operations.claim(claim)).toEqual({
      attempts: EMAIL_DELIVERY_MAX_ATTEMPTS,
      outcome: 'duplicate',
      status: 'failed',
      templateId: 'fixture'
    })
  })

  it('does not let another template reuse an event key, even after a failure', async () => {
    const { operations } = ledger()
    await operations.claim(claim)
    await operations.complete({ attempt: 1, eventKey: claim.eventKey, status: 'failed' })
    expect(await operations.claim({ ...claim, templateId: 'other-template' })).toMatchObject({
      outcome: 'duplicate',
      status: 'failed',
      templateId: 'fixture'
    })
  })

  it('ignores a completion for an attempt the row no longer holds', async () => {
    const { operations, row } = ledger()
    await operations.claim(claim)
    await operations.complete({ attempt: 1, eventKey: claim.eventKey, status: 'failed' })
    await operations.claim(claim)
    expect(
      await operations.complete({ attempt: 1, eventKey: claim.eventKey, status: 'sent' })
    ).toBe(false)
    expect(
      await operations.complete({ attempt: 1, eventKey: 'fixture:unknown', status: 'sent' })
    ).toBe(false)
    expect(row(claim.eventKey)).toMatchObject({ attempts: 2, status: 'sending' })
  })

  it('stores only well-formed error codes', async () => {
    const { operations, row } = ledger()
    await operations.claim(claim)
    await operations.complete({
      attempt: 1,
      errorCode: 'Recipient person@example.com is suppressed',
      eventKey: claim.eventKey,
      status: 'failed'
    })
    expect(row(claim.eventKey)?.last_error_code).toBe('E_UNKNOWN')
  })

  it('refuses event keys that could carry an address or are malformed', async () => {
    const { d1, operations } = ledger()
    for (const eventKey of ['person@example.com', 'ab', 'Upper:Case', ' padded', 'x'.repeat(201)]) {
      expect(isEmailEventKey(eventKey), eventKey).toBe(false)
      await expect(operations.claim({ ...claim, eventKey })).rejects.toThrow(/event key/u)
    }
    await expect(operations.claim({ ...claim, templateId: 'Bad Id' })).rejects.toThrow(/template/u)
    await expect(operations.claim({ ...claim, provider: '' })).rejects.toThrow(/provider/u)
    expect(() =>
      d1.database.exec(
        "INSERT INTO email_deliveries (event_key, template_id, provider, status) VALUES ('a@b.co', 't', 'p', 'sending')"
      )
    ).toThrow(/CHECK constraint/u)
  })

  it('binds every runtime value', async () => {
    const { d1, operations } = ledger()
    await operations.claim(claim)
    await operations.complete({ attempt: 1, eventKey: claim.eventKey, status: 'sent' })
    expect(d1.statements.length).toBeGreaterThan(0)
    for (const statement of d1.statements) {
      expect(statement.sql).not.toContain(claim.eventKey)
      expect(statement.bindings).toContain(claim.eventKey)
    }
  })
})

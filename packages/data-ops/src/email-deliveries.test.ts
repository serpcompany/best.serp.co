import { describe, expect, it } from 'vitest'
import { createDatabase } from './client'
import {
  createEmailDeliveryLedger,
  EMAIL_DELIVERY_MAX_ATTEMPTS,
  isEmailEventKey,
  sqliteTimestamp
} from './email-deliveries'
import { SqliteD1 } from './test-support'

function ledger(start = Date.UTC(2026, 9, 6, 12, 0, 0)) {
  const d1 = new SqliteD1()
  let tick = 0
  const operations = createEmailDeliveryLedger({
    client: createDatabase(d1.asD1Database()),
    clock: () => new Date(start + 1000 * tick++)
  })
  const row = (eventKey: string, templateId = 'fixture') =>
    d1.database
      .prepare('SELECT * FROM email_deliveries WHERE template_id = ? AND event_key = ?')
      .get(templateId, eventKey) as Record<string, unknown> | undefined
  return { d1, operations, row }
}

const claim = { eventKey: 'fixture:event-1', provider: 'cloudflare', templateId: 'fixture' }
const done = { eventKey: claim.eventKey, templateId: claim.templateId }

describe('email delivery ledger', () => {
  it('claims a template and event key once; a second claim is a duplicate in flight', async () => {
    const { operations, row } = ledger()
    expect(await operations.claim(claim)).toEqual({ attempt: 1, outcome: 'claimed' })
    expect(await operations.claim(claim)).toEqual({
      attempts: 1,
      exhausted: false,
      outcome: 'duplicate',
      status: 'sending'
    })
    expect(row(claim.eventKey)).toMatchObject({
      attempts: 1,
      created_at: '2026-10-06 12:00:00',
      provider: 'cloudflare',
      status: 'sending',
      template_id: 'fixture'
    })
  })

  it('lets one event send several templates', async () => {
    const { operations } = ledger()
    expect(await operations.claim(claim)).toMatchObject({ outcome: 'claimed' })
    expect(await operations.claim({ ...claim, templateId: 'admin-notice' })).toMatchObject({
      outcome: 'claimed'
    })
    expect(await operations.claim({ ...claim, templateId: 'admin-notice' })).toMatchObject({
      outcome: 'duplicate'
    })
  })

  it('gives exactly one of several concurrent claims the send', async () => {
    const { operations } = ledger()
    const claims = await Promise.all(Array.from({ length: 5 }, () => operations.claim(claim)))
    expect(claims.filter(result => result.outcome === 'claimed')).toEqual([
      { attempt: 1, outcome: 'claimed' }
    ])
    expect(claims.filter(result => result.outcome === 'duplicate')).toHaveLength(4)
  })

  it('never re-claims a sent event and records the provider message id', async () => {
    const { operations, row } = ledger()
    await operations.claim(claim)
    expect(
      await operations.complete({
        ...done,
        attempt: 1,
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

  it('re-claims a failed event for another attempt, then reports it exhausted', async () => {
    const { operations, row } = ledger()
    for (let attempt = 1; attempt <= EMAIL_DELIVERY_MAX_ATTEMPTS; attempt++) {
      expect(await operations.claim(claim)).toEqual({ attempt, outcome: 'claimed' })
      expect(row(claim.eventKey)).toMatchObject({ last_error_code: null, status: 'sending' })
      await operations.complete({
        ...done,
        attempt,
        errorCode: 'E_RATE_LIMIT_EXCEEDED',
        status: 'failed'
      })
      expect(row(claim.eventKey)).toMatchObject({
        last_error_code: 'E_RATE_LIMIT_EXCEEDED',
        status: 'failed'
      })
    }
    expect(await operations.claim(claim)).toEqual({
      attempts: EMAIL_DELIVERY_MAX_ATTEMPTS,
      exhausted: true,
      outcome: 'duplicate',
      status: 'failed'
    })
  })

  it('ignores a completion for an attempt the row no longer holds', async () => {
    const { operations, row } = ledger()
    await operations.claim(claim)
    await operations.complete({ ...done, attempt: 1, status: 'failed' })
    await operations.claim(claim)
    expect(await operations.complete({ ...done, attempt: 1, status: 'sent' })).toBe(false)
    expect(
      await operations.complete({
        ...done,
        attempt: 1,
        eventKey: 'fixture:unknown',
        status: 'sent'
      })
    ).toBe(false)
    expect(
      await operations.complete({ ...done, attempt: 2, status: 'sent', templateId: 'other' })
    ).toBe(false)
    expect(row(claim.eventKey)).toMatchObject({ attempts: 2, status: 'sending' })
  })

  it('stores only well-formed error codes', async () => {
    const { operations, row } = ledger()
    await operations.claim(claim)
    await operations.complete({
      ...done,
      attempt: 1,
      errorCode: 'Recipient person@example.com is suppressed',
      status: 'failed'
    })
    expect(row(claim.eventKey)?.last_error_code).toBe('E_UNKNOWN')
  })

  it("writes SQLite's timestamp format, so datetime() windows find old rows", async () => {
    expect(sqliteTimestamp(new Date('2026-10-06T12:34:56.789Z'))).toBe('2026-10-06 12:34:56')
    const { d1, operations, row } = ledger(Date.UTC(2020, 0, 1, 0, 0, 0))
    await operations.claim(claim)
    const stored = row(claim.eventKey)
    expect(stored?.updated_at).toBe('2020-01-01 00:00:00')
    expect(
      d1.database.prepare('SELECT datetime(updated_at) AS normalized FROM email_deliveries').get()
    ).toEqual({ normalized: stored?.updated_at })
    // The docs/EMAIL.md query for sends stuck in `sending`.
    expect(
      d1.database
        .prepare(
          "SELECT count(*) AS stuck FROM email_deliveries WHERE status = 'sending' AND updated_at < datetime('now', '-15 minutes')"
        )
        .get()
    ).toEqual({ stuck: 1 })
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
    await operations.complete({ ...done, attempt: 1, status: 'sent' })
    expect(d1.statements.length).toBeGreaterThan(0)
    for (const statement of d1.statements) {
      expect(statement.sql).not.toContain(claim.eventKey)
      expect(statement.bindings).toContain(claim.eventKey)
    }
  })
})

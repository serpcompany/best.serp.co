import { describe, expect, it, vi } from 'vitest'
import {
  createEmailOtpSender,
  OtpDeliveryUnavailableError,
  type SignInCodeEmail,
  selectOtpSender,
  unavailableOtpSender
} from './otp-sender'

const message = {
  email: 'owner@example.com',
  expiresInSeconds: 600,
  otp: '482913',
  purpose: 'sign-in' as const
}

function email(
  templateRegistered: boolean
): SignInCodeEmail & { enqueue: ReturnType<typeof vi.fn> } {
  let calls = 0
  return {
    enqueue: vi.fn(async () => undefined),
    eventKey: () => {
      calls += 1
      return `sign-in-code:00000000-0000-4000-8000-00000000000${calls}`
    },
    templateRegistered
  }
}

describe('sign-in code senders', () => {
  it('uses the dev sender locally only', () => {
    expect(selectOtpSender('local').kind).toBe('dev-console')
    expect(selectOtpSender('local', email(true)).kind).toBe('dev-console')
  })

  it('keeps staging and production unavailable until the sign-in-code template exists', () => {
    for (const environment of ['staging', 'production'] as const) {
      expect(selectOtpSender(environment)).toBe(unavailableOtpSender)
      expect(selectOtpSender(environment, email(false))).toBe(unavailableOtpSender)
      expect(selectOtpSender(environment, email(true)).kind).toBe('email')
    }
  })

  it('enqueues one sign-in-code email per code, keyed by a new event each time', async () => {
    const delivery = email(true)
    const sender = createEmailOtpSender(delivery)
    await sender.send(message)
    await sender.send({ ...message, otp: '000111' })
    expect(delivery.enqueue.mock.calls).toEqual([
      [
        {
          eventKey: 'sign-in-code:00000000-0000-4000-8000-000000000001',
          input: { code: '482913', expiresInMinutes: 10 },
          to: 'owner@example.com'
        }
      ],
      [
        {
          eventKey: 'sign-in-code:00000000-0000-4000-8000-000000000002',
          input: { code: '000111', expiresInMinutes: 10 },
          to: 'owner@example.com'
        }
      ]
    ])
    // The key never carries the code.
    expect(JSON.stringify(delivery.enqueue.mock.calls.map(call => call[0].eventKey))).not.toMatch(
      /482913|000111/u
    )
  })

  it('sends nothing but sign-in codes', async () => {
    const delivery = email(true)
    await expect(
      createEmailOtpSender(delivery).send({ ...message, purpose: 'forget-password' })
    ).rejects.toBeInstanceOf(OtpDeliveryUnavailableError)
    expect(delivery.enqueue).not.toHaveBeenCalled()
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountSubmissionDetail } from '@/db/account'
import type { AdminReviewReadyInput } from '@/lib/email/emails/admin'
import { renderAppEmail } from '@/lib/email/emails/samples'
import { sendResubmittedAlert } from './emails'

const { enqueueEmail } = vi.hoisted(() => ({ enqueueEmail: vi.fn(async () => {}) }))

vi.mock('server-only', () => ({}))
vi.mock('@/lib/email/server', () => ({
  EMAIL_ADMIN_RECIPIENT: 'admin@example.com',
  emailEventKey: (...parts: string[]) => parts.join(':'),
  enqueueEmail
}))

function resubmitted(overrides: Partial<AccountSubmissionDetail>): AccountSubmissionDetail {
  return {
    badgeVerifiedAt: null,
    categoryName: 'Tools',
    categorySlug: 'tools',
    contentVersion: 2,
    id: 's1',
    listing: { live: false, slug: 's1.example' },
    name: 'Quillmate',
    paidAt: '2026-10-05T10:00:00.000Z',
    paymentLoss: null,
    plan: 'paid',
    website: 'https://s1.example/',
    ...overrides
  } as AccountSubmissionDetail
}

/** The plan the resubmission's "ready for review" alert carries, and how the email says it. */
async function sent(submission: AccountSubmissionDetail) {
  await sendResubmittedAlert({ submission, submitterEmail: 'maya@example.com' })
  const [, request] = enqueueEmail.mock.calls.at(-1) as unknown as [
    string,
    { input: AdminReviewReadyInput }
  ]
  const email = renderAppEmail('admin-review-ready', request.input, {
    environment: 'production',
    to: 'admin@example.com'
  })
  return { email, plan: request.input.plan }
}

describe('the resubmission alert’s plan (#484)', () => {
  beforeEach(() => enqueueEmail.mockClear())

  it.each(['disputed', 'refunded'] as const)(
    'says a paid submission’s payment was %s, and never claims a badge check',
    async loss => {
      const { email, plan } = await sent(resubmitted({ paymentLoss: loss }))
      expect(plan).toEqual({ kind: 'paid', live: false, loss })
      expect(email.subject).toBe(`Ready for review: Quillmate (paid, payment ${loss})`)
      expect(email.text).toContain(`Plan: Paid. Payment ${loss}`)
      expect(email.text).not.toContain('Badge verified')
    }
  )

  it('keeps a kept payment paid, and a free submission’s badge check', async () => {
    await expect(
      sent(resubmitted({ listing: { live: true, slug: 's1.example' } }))
    ).resolves.toMatchObject({ plan: { kind: 'paid', live: true } })
    const free = await sent(
      resubmitted({ badgeVerifiedAt: '2026-10-06T10:42:00.000Z', paidAt: null, plan: 'free' })
    )
    expect(free.plan).toEqual({ badgeVerifiedAt: '2026-10-06T10:42:00.000Z', kind: 'free' })
    expect(free.email.subject).toBe('Ready for review: Quillmate (free, badge verified)')
  })
})

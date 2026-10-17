import type { ReactElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const session = vi.hoisted(() => ({
  admin: false,
  user: { email: 'devin@serp.co', emailVerified: true, id: 'user-1', name: 'Devin' }
}))
const reviewQueueCounts = vi.hoisted(() => vi.fn())
const getAdminReads = vi.hoisted(() => vi.fn(async () => ({ reviewQueueCounts })))

vi.mock('server-only', () => ({}))
vi.mock('@/lib/route-feature-gates', () => ({ requireRouteFeature: () => {} }))
vi.mock('@/lib/billing/runtime', () => ({ ordersEnabled: async () => false }))
vi.mock('@/lib/account/overview', () => ({ getAccountOverview: async () => ({}) }))
vi.mock('@/lib/account/view', () => ({ accountRows: () => [] }))
vi.mock('@/lib/auth/server', () => ({
  getSessionAdmin: async () => (session.admin ? session.user : null),
  getSessionUser: async () => session.user
}))
vi.mock('@/lib/admin/runtime', () => ({ getAdminReads }))
vi.mock('@/components/account/account-shell', () => ({ AccountShell: () => null }))

/** The `reviewQueueCount` the layout hands the account shell. */
async function reviewQueueCount(): Promise<number | undefined> {
  const { default: AccountLayout } = await import('./layout')
  const shell = (await AccountLayout({ children: null })) as ReactElement<{
    reviewQueueCount?: number
  }>
  return shell.props.reviewQueueCount
}

beforeEach(() => {
  session.admin = false
  getAdminReads.mockClear()
  reviewQueueCounts.mockReset()
})

describe('account layout review queue count (#489)', () => {
  it('gives an admin the admin queue’s waiting count', async () => {
    session.admin = true
    reviewQueueCounts.mockResolvedValue({ changes: 1, oldestQueuedAt: null, waiting: 3 })
    expect(await reviewQueueCount()).toBe(3)
  })

  it('never reads the queue for anyone else', async () => {
    expect(await reviewQueueCount()).toBeUndefined()
    expect(getAdminReads).not.toHaveBeenCalled()
    expect(reviewQueueCounts).not.toHaveBeenCalled()
  })
})

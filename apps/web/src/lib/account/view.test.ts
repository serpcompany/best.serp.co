import type {
  AccountListing,
  AccountOverview,
  AccountSubmission
} from '@/db/account'
import { describe, expect, it } from 'vitest'
import { accountCards, accountRows, categoryChoices } from './view'

/** The dashboard's table (#65, #70 screen 5): which rows, statuses, next steps, and menus. */

const NOW = new Date('2026-10-06T12:00:00.000Z')

function submission(id: string, overrides: Partial<AccountSubmission> = {}): AccountSubmission {
  return {
    badgeVerifiedAt: null,
    categoryName: 'Tools',
    categorySlug: 'tools',
    contentVersion: 1,
    createdAt: '2026-10-05T10:00:00.000Z',
    description: 'A product.',
    draftSavedAt: null,
    id,
    lastVerificationAt: null,
    lastVerificationError: null,
    listing: null,
    logoUrl: `https://${id}.example/logo.png`,
    name: id,
    paidAt: null,
    plan: 'free',
    refundedAt: null,
    rejection: null,
    reviewedAt: null,
    reviewerNote: null,
    slug: `${id}.example`,
    status: 'verified',
    updatedAt: '2026-10-05T10:00:00.000Z',
    verificationAttempts: 1,
    website: `https://${id}.example/`,
    withdrawalReason: null,
    ...overrides
  }
}

function listing(id: string, overrides: Partial<AccountListing> = {}): AccountListing {
  return {
    badge: null,
    categoryName: 'Tools',
    categorySlug: 'tools',
    description: 'Live.',
    id,
    live: true,
    logoUrl: null,
    name: id,
    plan: 'paid',
    publishedAt: '2026-10-01T00:00:00.000Z',
    revision: null,
    slug: `${id}.example`,
    submission: null,
    verifiedVia: 'submission',
    website: `https://${id}.example/`,
    ...overrides
  }
}

const target = (slug: string) => ({
  badgeUrl: 'https://best.serp.co/badge.svg',
  listingUrl: `https://best.serp.co/products/${slug}/`
})

function rows(overview: AccountOverview) {
  return accountRows(overview, { badgeTarget: target, now: NOW, showPaid: false })
}

describe('account rows', () => {
  it('maps each submission status to its chip, next step, and action', () => {
    const table = rows({
      listings: [],
      submissions: [
        submission('draft', {
          draftSavedAt: '2026-10-05T12:00:00.000Z',
          plan: null,
          status: 'draft'
        }),
        submission('badge', { status: 'pending_badge' }),
        submission('review'),
        submission('fix', { status: 'changes_requested' }),
        submission('no', {
          rejection: { category: 'other', reason: 'The domain is parked. Nothing to list yet.' },
          status: 'rejected'
        }),
        submission('gone', { status: 'withdrawn', withdrawalReason: 'expired' })
      ]
    })
    const by = Object.fromEntries(table.map(row => [row.id, row]))
    expect(by.draft).toMatchObject({
      action: { href: '/submit/draft/choose/', label: 'Continue' },
      draftExpiresInDays: 29,
      next: { text: 'Choose how to get listed' },
      status: 'plan_draft',
      tab: 'action'
    })
    expect(by.badge).toMatchObject({ action: { label: 'Add badge' }, status: 'pending_badge' })
    expect(by.review).toMatchObject({ action: null, status: 'in_review', tab: 'review' })
    expect(by.fix).toMatchObject({
      action: { href: '/account/submissions/fix/', label: 'Edit' },
      next: { text: 'Fix and resubmit' },
      status: 'changes'
    })
    expect(by.no?.next.text).toBe('Rejected: The domain is parked')
    expect(by.gone).toMatchObject({
      action: { href: '/submit/?url=https%3A%2F%2Fgone.example%2F', label: 'Submit again' },
      next: { text: 'Draft expired after 30 days' },
      tab: 'closed'
    })
  })

  it('offers Withdraw only before payment, and "Message us" once paid', () => {
    const table = rows({
      listings: [],
      submissions: [
        submission('free'),
        submission('paid', { paidAt: '2026-10-05T10:00:00.000Z', plan: 'paid' }),
        submission('live', {
          listing: { live: true, slug: 'live.example' },
          paidAt: '2026-10-05T10:00:00.000Z',
          plan: 'paid',
          status: 'paid_pending_review'
        })
      ]
    })
    expect(table.map(row => [row.id, row.menu])).toEqual(
      expect.arrayContaining([
        ['free', { messageUs: false, withdraw: true }],
        ['paid', { messageUs: true, withdraw: false }],
        ['live', { messageUs: true, withdraw: false }]
      ])
    )
  })

  it('shows a listing once: as its submission while that is in review, else as the listing', () => {
    const table = rows({
      listings: [
        listing('queued', { slug: 'queued.example' }),
        listing('free', {
          badge: {
            history: [
              {
                at: '2026-10-05T09:14:00.000Z',
                by: 'owner',
                conclusive: true,
                fromPanel: true,
                outcome: 'fail',
                reason: 'link_not_followed'
              }
            ],
            lastCheckAt: '2026-10-05T09:14:00.000Z',
            lastError: 'link_not_followed',
            submissionId: 'sub-free',
            checksInWindow: 2
          },
          plan: 'free'
        }),
        listing('down', { live: false })
      ],
      submissions: [
        submission('queued-sub', {
          listing: { live: true, slug: 'queued.example' },
          paidAt: '2026-10-05T10:00:00.000Z',
          plan: 'paid',
          status: 'paid_pending_review'
        }),
        submission('approved', { status: 'approved' })
      ]
    })
    expect(table.map(row => row.key).sort()).toEqual([
      'listing:down',
      'listing:free',
      'submission:queued-sub'
    ])
    const free = table.find(row => row.id === 'free')
    expect(free).toMatchObject({
      action: 'badge',
      badge: { checksLeft: 8, failing: true },
      next: { text: 'Badge failing: link is nofollow', tone: 'warning' },
      status: 'live'
    })
    expect(table.find(row => row.id === 'down')).toMatchObject({
      badge: null,
      status: 'unlisted',
      tab: 'closed'
    })
    const cards = accountCards(table)
    expect(cards.live).toMatchObject({ count: 2, paid: 1 })
    expect(cards.badges.failing.map(row => row.id)).toEqual(['free'])
  })

  it('keeps an inactive category selectable in an edit form', () => {
    expect(
      categoryChoices([{ name: 'Tools', slug: 'tools' }], { name: 'Old', slug: 'old' })
    ).toEqual([
      { label: 'Old', slug: 'old' },
      { label: 'Tools', slug: 'tools' }
    ])
    expect(
      categoryChoices([{ name: 'Tools', slug: 'tools' }], { name: 'Tools', slug: 'tools' })
    ).toHaveLength(1)
  })
})

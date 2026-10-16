import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type QueueRow, ReviewQueue } from './review-queue'

vi.mock('next/navigation', () => ({
  usePathname: () => '/admin/submissions/',
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} })
}))

function row(id: string, overrides: Partial<QueueRow>): QueueRow {
  return {
    badge: null,
    href: `/admin/submissions/${id}/`,
    id,
    kind: 'submission',
    listingSlug: null,
    logoUrl: null,
    name: id,
    ownerEmail: 'maya@example.com',
    paid: true,
    paidAmountCents: null,
    paymentLoss: null,
    queuedAt: '2026-10-15T10:00:00.000Z',
    slug: `${id}.example`,
    status: 'paid_pending_review',
    website: `https://${id}.example/`,
    ...overrides
  }
}

describe('the review queue’s plan (#484)', () => {
  beforeEach(() => {
    vi.stubGlobal('React', React)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** Each row's Plan and Paid cells, in the table's order. */
  function cells(rows: QueueRow[]) {
    const markup = renderToStaticMarkup(
      <ReviewQueue
        counts={{ changes: 0, waiting: rows.length }}
        initialFilters={{ badge: [], plan: [], source: [] }}
        rows={rows}
        view="waiting"
      />
    )
    return Object.fromEntries(
      rows.map(({ id }) => {
        const tr = markup.split('<tr').find(part => part.includes(`>${id}<`)) ?? ''
        const text = tr.replace(/<[^>]+>/gu, '|')
        return [
          id,
          {
            paid: /\|(Refunded|Disputed|\$49\.00)\|/u.exec(text)?.[1],
            plan: /\|(Paid|Free)\|/u.exec(text)?.[1]
          }
        ]
      })
    )
  }

  it('reads a paid submission whose payment was disputed or refunded as free', () => {
    expect(
      cells([
        row('kept', { paidAmountCents: 4900 }),
        row('disputed', { paymentLoss: 'disputed' }),
        row('refunded', { paymentLoss: 'refunded' })
      ])
    ).toEqual({
      disputed: { paid: 'Disputed', plan: 'Free' },
      kept: { paid: '$49.00', plan: 'Paid' },
      refunded: { paid: 'Refunded', plan: 'Free' }
    })
  })
})

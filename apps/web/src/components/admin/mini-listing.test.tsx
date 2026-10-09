import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ListingDetail } from '@/db/contracts'
import { MiniListing } from './mini-listing'

const listing: ListingDetail = {
  category: 'e2e-tools',
  content: 'It helps reviewers see the staged listing.',
  description: 'A staged listing.',
  linkRel: 'follow',
  media: {
    images: ['https://cdn.example/best.serp.co/listings/staged/image/1.png'],
    logo: 'https://cdn.example/best.serp.co/listings/staged/logo/1.png'
  },
  modifiedAt: '2026-10-09T00:00:00.000Z',
  name: 'Staged Tool',
  nextWebsite: null,
  previousWebsite: null,
  publishedAt: '2026-10-09',
  relatedWebsites: [],
  faqs: [{ answer: 'Yes, every plan includes it.', question: 'Is there a free plan?' }],
  resourceLinks: [{ label: 'Docs', url: 'https://docs.staged.example/' }],
  slug: 'staged.example',
  website: 'https://staged.example/'
}

describe('admin review preview (#292)', () => {
  beforeEach(() => {
    vi.stubGlobal('React', React)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const markup = (verifiedOwner = false) =>
    renderToStaticMarkup(
      <MiniListing categoryName="E2E Tools" listing={listing} verifiedOwner={verifiedOwner} />
    )
  /** The header: everything before the separator over the content. */
  const header = (html: string) => html.split('data-slot="separator"')[0] ?? ''

  it("draws the product page's header: the name, description, staged category and Visit Site", () => {
    const html = markup()
    // The review page's `h1` is the record; the preview's name is the next level (#296).
    expect(header(html)).toMatch(/<h2[^>]*>Staged Tool<\/h2>/)
    expect(html).toContain('Staged Tool')
    expect(html).toContain('A staged listing.')
    expect(html).toContain('E2E Tools')
    expect(html).toContain('Visit Site')
  })

  it('draws the featured image once, in the content section', () => {
    expect(markup().split('/listings/staged/image/1.png').length - 1).toBe(1)
  })

  it("links nowhere in the header: it's a picture of the page", () => {
    expect(header(markup())).not.toContain('<a ')
  })

  it('draws the staged resource links under the content, as the product page does (#296)', () => {
    const html = markup()
    expect(header(html)).not.toContain('docs.staged.example')
    expect(html).toContain('Docs')
    expect(html).toContain('docs.staged.example')
  })

  it('draws the staged FAQs, as the product page does (#296 review)', () => {
    const html = markup()
    expect(header(html)).not.toContain('Is there a free plan?')
    expect(html).toContain('Is there a free plan?')
  })

  it('shows Verified owner only when asked to (#296)', () => {
    expect(header(markup(true))).toContain('Verified owner')
    expect(markup()).not.toContain('Verified owner')
  })
})

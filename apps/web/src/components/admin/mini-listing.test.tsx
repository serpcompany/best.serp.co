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

  const markup = () =>
    renderToStaticMarkup(<MiniListing categoryName="E2E Tools" listing={listing} />)

  it("draws the product page's header: the name, description, staged category and Visit Site", () => {
    const html = markup()
    expect(html).toContain('<h3')
    expect(html).toContain('Staged Tool')
    expect(html).toContain('A staged listing.')
    expect(html).toContain('E2E Tools')
    expect(html).toContain('Visit Site')
  })

  it('draws the featured image once, in the content section', () => {
    expect(markup().split('/listings/staged/image/1.png').length - 1).toBe(1)
  })

  it('links nowhere: the preview is a picture of the page', () => {
    expect(markup()).not.toContain('<a ')
  })
})

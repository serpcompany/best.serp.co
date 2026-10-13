import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebsiteMetadata } from '../../lib/directory/content-query'
import { listingContentTree } from '../../lib/markdown/listing-content-tree'
import { WebsiteContentSection } from './website-content-section'

const website: WebsiteMetadata = {
  category: 'fixture-tools',
  content: 'Parsed body\n\n| Plan | Price |\n| --- | ---: |\n| Free | $0 |',
  description: 'A fixture listing.',
  name: 'Fixture',
  publishedAt: '2026-07-04T00:00:00.000Z',
  slug: 'fixture.test',
  website: 'https://fixture.test/'
}

describe('a listing body (#334)', () => {
  beforeEach(() => {
    vi.stubGlobal('React', React)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders the cached tree when the page has one, without parsing the body', () => {
    const markup = renderToStaticMarkup(
      <WebsiteContentSection
        contentTree={listingContentTree('Cached body', false)}
        website={website}
      />
    )
    expect(markup).toContain('Cached body')
    expect(markup).not.toContain('Parsed body')
  })

  it('parses the body with the shared options when there is no tree', () => {
    const markup = renderToStaticMarkup(<WebsiteContentSection website={website} />)
    expect(markup).toContain('Parsed body')
    // A GitHub-flavored table: the GFM extensions are in LISTING_MARKDOWN_OPTIONS.
    expect(markup).toContain('<table class="w-full">')
    expect(markup).toBe(
      renderToStaticMarkup(
        <WebsiteContentSection
          contentTree={listingContentTree(website.content as string, false)}
          website={website}
        />
      )
    )
  })
})

describe('a listing body without content (#416)', () => {
  const bare: WebsiteMetadata = { ...website, category: 'audio', content: undefined }

  beforeEach(() => {
    vi.stubGlobal('React', React)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("names its categories as the page hands them, D1's names", () => {
    const markup = renderToStaticMarkup(
      <WebsiteContentSection
        categories={[{ name: 'Audio & Music', slug: 'audio' }]}
        website={bare}
      />
    )
    expect(markup).toContain('Audio &amp; Music')
  })

  it('names them from their slugs only without them', () => {
    expect(renderToStaticMarkup(<WebsiteContentSection website={bare} />)).toContain('>Audio<')
  })
})

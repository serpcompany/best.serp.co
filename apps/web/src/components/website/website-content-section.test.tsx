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
    // A GitHub-flavored table: remark-gfm is in LISTING_MARKDOWN_OPTIONS.
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

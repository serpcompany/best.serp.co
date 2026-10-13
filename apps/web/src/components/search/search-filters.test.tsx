import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SearchFilters } from './search-filters'
import { transformToWebsiteMetadata } from './search-utils'

describe('the search filters name categories from D1 (#416)', () => {
  beforeEach(() => {
    vi.stubGlobal('React', React)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("keep the search API's names on each result", () => {
    expect(
      transformToWebsiteMetadata({
        category: 'audio',
        categoryNames: { audio: 'Audio & Music' },
        description: 'Makes music.',
        name: 'Fixture Tunes',
        slug: 'fixture-tunes.test',
        url: '/products/fixture-tunes.test/',
        website: 'https://fixture-tunes.test/'
      }).categoryNames
    ).toEqual({ audio: 'Audio & Music' })
  })

  it("show D1's name, and a slug's own only when D1 has none", () => {
    const markup = renderToStaticMarkup(
      <SearchFilters
        availableCategories={['audio', 'retired-hub']}
        categoryNames={new Map([['audio', 'Audio & Music']])}
        onCategoryChange={() => undefined}
        selectedCategories={['audio', 'retired-hub']}
      />
    )
    expect(markup).toContain('Audio &amp; Music')
    expect(markup).toContain('aria-label="Remove Audio &amp; Music filter"')
    expect(markup).toContain('Retired Hub')
    expect(markup).not.toMatch(/>Audio</u)
  })
})

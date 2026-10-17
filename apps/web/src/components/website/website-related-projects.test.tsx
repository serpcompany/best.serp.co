import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebsiteRelatedCardMetadata } from '../../lib/directory/content-query'
import { WebsiteRelatedProjects } from './website-related-projects'

const alternative = (slug: string): WebsiteRelatedCardMetadata => ({
  description: `${slug} description`,
  name: `${slug} name`,
  slug,
  website: `https://${slug}/`
})

describe("a listing page's Alternatives section (#519)", () => {
  beforeEach(() => {
    vi.stubGlobal('React', React)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows every alternative the catalog read returns, in order, under "Alternatives"', () => {
    const slugs = [
      'zebra.test',
      'kiwi.test',
      'apple.test',
      'banana.test',
      'olive.test',
      'pear.test'
    ]
    const markup = renderToStaticMarkup(
      <WebsiteRelatedProjects websites={slugs.map(alternative)} />
    )
    // A region named by its heading, in the look "Related Entries" had.
    expect(markup).toContain('<section aria-labelledby="alternatives">')
    expect(markup).toMatch(/<h2[^>]* id="alternatives">Alternatives<\/h2>/u)
    expect(markup).not.toContain('Related Entries')
    const linked = [...markup.matchAll(/href="\/products\/([^/"]+)\/?"/gu)].map(match => match[1])
    expect([...new Set(linked)]).toEqual(slugs)
    // Six cards, none hidden: the read returns at most six, so the section cuts none.
    expect(markup.match(/<li /gu)).toHaveLength(6)
    expect(markup).not.toContain('hidden=""')
  })

  it('renders nothing without an alternative', () => {
    expect(renderToStaticMarkup(<WebsiteRelatedProjects websites={[]} />)).toBe('')
  })
})

import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebsiteRelatedCardMetadata } from '../../lib/directory/content-query'
import { WebsiteAlternatives } from './website-alternatives'
import { WebsiteRelated } from './website-related'

const listing = (slug: string): WebsiteRelatedCardMetadata => ({
  description: `${slug} description`,
  name: `${slug} name`,
  slug,
  website: `https://${slug}/`
})

const slugs = ['zebra.test', 'kiwi.test', 'apple.test', 'banana.test', 'olive.test', 'pear.test']
const linked = (markup: string) => [
  ...new Set([...markup.matchAll(/href="\/products\/([^/"]+)\/?"/gu)].map(match => match[1]))
]

describe("a listing page's Alternatives list and Related section (#519, #535)", () => {
  beforeEach(() => {
    vi.stubGlobal('React', React)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('lists every alternative in order, as a logo and a name, under "Alternatives"', () => {
    const markup = renderToStaticMarkup(<WebsiteAlternatives websites={slugs.map(listing)} />)
    // A region named by its heading.
    expect(markup).toContain('<section aria-labelledby="alternatives">')
    expect(markup).toMatch(/<h2 id="alternatives">Alternatives<\/h2>/u)
    expect(linked(markup)).toEqual(slugs)
    expect(markup.match(/<li>/gu)).toHaveLength(6)
    // The compact list: names and logos, no descriptions.
    expect(markup).toContain('zebra.test name')
    expect(markup).not.toContain('zebra.test description')
    expect(markup.match(/data-listing-image="logo"/gu)).toHaveLength(6)
  })

  it('shows every related listing in order, as cards under "Related"', () => {
    const markup = renderToStaticMarkup(<WebsiteRelated websites={slugs.map(listing)} />)
    // A region named by its heading, in the cards the Alternatives section had.
    expect(markup).toContain('<section aria-labelledby="related">')
    expect(markup).toMatch(/<h2[^>]* id="related">Related<\/h2>/u)
    expect(linked(markup)).toEqual(slugs)
    // Six cards, none hidden: the read returns at most six, so the section cuts none.
    expect(markup.match(/<li /gu)).toHaveLength(6)
    expect(markup).not.toContain('hidden=""')
    expect(markup).toContain('zebra.test description')
  })

  it('renders nothing without a listing to show', () => {
    expect(renderToStaticMarkup(<WebsiteAlternatives websites={[]} />)).toBe('')
    expect(renderToStaticMarkup(<WebsiteRelated websites={[]} />)).toBe('')
  })
})

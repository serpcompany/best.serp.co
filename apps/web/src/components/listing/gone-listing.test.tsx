import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderingCategory } from '@/lib/seo/taxonomy-indexing'
import { GoneListing } from './gone-listing'

/** Hrefs in the markup; next/link drops the trailing slash outside the app. */
function hrefs(markup: string): string[] {
  return [...markup.matchAll(/<a [^>]*href="([^"]+)"/gu)].map(([, href]) =>
    (href ?? '').replace(/(.)\/$/u, '$1')
  )
}

const categories = [
  { count: 12, description: '', name: 'Writing Tools', order: 0, slug: 'writing-tools' },
  // Its last public listing was unpublished: its page answers 404.
  { count: 0, description: '', name: 'Audio Tools', order: 1, slug: 'audio-tools' }
]
const alternative = (slug: string) => ({
  description: `${slug} description`,
  name: `${slug} listing`,
  slug,
  website: `https://${slug}.test/`
})
const links = {
  bestPages: [],
  categories: [categories[0]] as typeof categories,
  listingTotal: 12,
  newest: [{ name: 'Inkpot', slug: 'inkpot' }]
}

function page(
  category: string,
  {
    alternatives = [],
    bestPages = [],
    more = []
  }: {
    alternatives?: ReturnType<typeof alternative>[]
    bestPages?: { heading: string; slug: string }[]
    more?: { name: string; slug: string }[]
  } = {}
) {
  return renderToStaticMarkup(
    <GoneListing
      alternatives={alternatives}
      bestPages={bestPages}
      hub={renderingCategory(categories, category)}
      links={alternatives.length ? null : links}
      listing={{ name: 'Fixture Scribe' }}
      more={more}
    />
  )
}

/** The `h2` headings' text, links included. */
function headings(markup: string): string[] {
  return [...markup.matchAll(/<h2 [^>]*>(.*?)<\/h2>/gu)].map(([, html]) =>
    (html ?? '').replace(/<[^>]+>/gu, '')
  )
}

beforeEach(() => {
  vi.stubGlobal('React', React)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the 410 page links the hub only while its page renders (#347)', () => {
  it('links the hub when its page renders', () => {
    const markup = page('writing-tools', { alternatives: [alternative('quill')] })
    expect(markup).toMatch(/<h1 [^>]*>Fixture Scribe is no longer listed<\/h1>/u)
    expect(hrefs(markup).slice(0, 3)).toEqual([
      '/products/categories/writing-tools',
      '/submit',
      '/products/categories/writing-tools'
    ])
  })

  it('links the directory when the hub has no public listing', () => {
    const markup = page('audio-tools')
    expect(hrefs(markup).slice(0, 2)).toEqual(['/products', '/submit'])
    expect(markup).not.toContain('Audio Tools')
    expect(markup).toContain('the directory')
  })
})

describe('the 410 page’s sections (#53)', () => {
  it('shows its category’s live listings as cards under the category, and not the 404 page’s links', () => {
    const markup = page('writing-tools', {
      alternatives: [alternative('quill'), alternative('inkpot')]
    })
    expect(markup).toMatch(
      /<h2 [^>]*id="gone-listing-alternatives"[^>]*><a [^>]*href="\/products\/categories\/writing-tools\/?"[^>]*>Writing Tools<\/a><\/h2>/u
    )
    expect(hrefs(markup)).toEqual(expect.arrayContaining(['/products/quill', '/products/inkpot']))
    expect(hrefs(markup)).not.toContain('/sitemap')
    expect(headings(markup)).toEqual(['Writing Tools'])
  })

  it('links the category’s best pages, then its other listings', () => {
    const markup = page('writing-tools', {
      alternatives: [alternative('quill')],
      bestPages: [
        { heading: 'Best Writing Apps', slug: 'writing-app' },
        { heading: 'Best Note Taking Apps', slug: 'note-taking-app' }
      ],
      more: [
        { name: 'Inkpot', slug: 'inkpot' },
        { name: 'Scrivo', slug: 'scrivo' }
      ]
    })
    expect(headings(markup)).toEqual(['Writing Tools', 'Best of', 'More in Writing Tools'])
    const after = hrefs(markup.slice(markup.indexOf('id="gone-listing-best"')))
    expect(after).toEqual([
      '/best/writing-app',
      '/best/note-taking-app',
      '/products/inkpot',
      '/products/scrivo'
    ])
  })

  it('shows the 404 page’s links when there is no alternative', () => {
    const markup = page('audio-tools')
    expect(markup).not.toContain('gone-listing-alternatives')
    expect(headings(markup)).toEqual(['Categories', 'Newest', 'Listings'])
    expect(hrefs(markup)).toEqual(
      expect.arrayContaining([
        '/products/categories',
        '/sitemap',
        '/products/categories/writing-tools',
        '/products/inkpot',
        '/sitemap/listings'
      ])
    )
  })
})

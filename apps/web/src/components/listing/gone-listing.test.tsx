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
const links = { bestPages: [], categories: [categories[0]] as typeof categories }

function page(
  category: string,
  {
    alternatives = [],
    bestPages = []
  }: {
    alternatives?: ReturnType<typeof alternative>[]
    bestPages?: { heading: string; slug: string }[]
  } = {}
) {
  return renderToStaticMarkup(
    <GoneListing
      alternatives={alternatives}
      bestPages={bestPages}
      hub={renderingCategory(categories, category)}
      links={links}
      listing={{ name: 'Fixture Scribe' }}
    />
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
    expect(hrefs(markup).slice(0, 3)).toEqual([
      '/products/categories/writing-tools',
      '/products/categories/writing-tools',
      '/submit'
    ])
    expect(markup).toContain('Browse Writing Tools')
  })

  it('links the directory when the hub has no public listing', () => {
    const markup = page('audio-tools')
    expect(hrefs(markup).slice(0, 3)).toEqual(['/products', '/products', '/submit'])
    expect(markup).not.toContain('Audio Tools')
    expect(markup).toContain('the directory')
  })
})

describe('the 410 page’s alternatives (#53)', () => {
  it('shows its category’s live listings, and not the 404 page’s links', () => {
    const markup = page('writing-tools', {
      alternatives: [alternative('quill'), alternative('inkpot')]
    })
    expect(markup).toMatch(/<h2 [^>]*id="gone-listing-alternatives"[^>]*>Alternatives<\/h2>/u)
    expect(hrefs(markup)).toEqual(expect.arrayContaining(['/products/quill', '/products/inkpot']))
    expect(hrefs(markup)).not.toContain('/sitemap')
  })

  it('links every best page of the category beside the category', () => {
    const markup = page('writing-tools', {
      alternatives: [alternative('quill')],
      bestPages: [
        { heading: 'Best Writing Apps', slug: 'writing-app' },
        { heading: 'Best Note Taking Apps', slug: 'note-taking-app' }
      ]
    })
    expect(hrefs(markup).slice(0, 4)).toEqual([
      '/products/categories/writing-tools',
      '/products/categories/writing-tools',
      '/best/writing-app',
      '/best/note-taking-app'
    ])
    expect(markup).toContain('Best Writing Apps')
    expect(markup).toContain('Best Note Taking Apps')
  })

  it('shows the 404 page’s links when there is no alternative', () => {
    const markup = page('audio-tools')
    expect(markup).not.toContain('Alternatives')
    expect(hrefs(markup)).toEqual(
      expect.arrayContaining([
        '/products/categories',
        '/sitemap',
        '/products/categories/writing-tools'
      ])
    )
  })
})

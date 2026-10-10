import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PublishedCategory } from '@/db/contracts'
import {
  buildHomePageData,
  HomePageCanonicalTags,
  HomePageRoute,
  homePageMetadata,
  homepageHubs
} from './home-page'

describe('homepage canonical URL', () => {
  beforeEach(() => {
    vi.stubGlobal('React', React)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('leaves canonical and og:url out of metadata, where Next.js would add a slash', () => {
    expect(homePageMetadata().alternates).toBeUndefined()
    expect(homePageMetadata().openGraph?.url).toBeUndefined()
    expect(homePageMetadata().openGraph?.title).toBeTruthy()
  })

  it('sets an absolute title, so the root layout template adds no suffix', () => {
    expect(homePageMetadata().title).toEqual({
      absolute: 'SERP Directory of Products and Resources'
    })
  })

  it('renders both tags with the bare origin', () => {
    expect(renderToStaticMarkup(<HomePageCanonicalTags />)).toBe(
      '<link rel="canonical" href="https://best.serp.co"/><meta property="og:url" content="https://best.serp.co"/>'
    )
  })

  it("renders staging's own bare origin on staging (#359)", () => {
    const key = Symbol.for('__cloudflare-context__')
    const global = globalThis as Record<symbol, unknown>
    global[key] = { env: { SITE_ENVIRONMENT: 'staging' } }
    try {
      expect(renderToStaticMarkup(<HomePageCanonicalTags />)).toBe(
        '<link rel="canonical" href="https://staging.best.serp.co"/><meta property="og:url" content="https://staging.best.serp.co"/>'
      )
    } finally {
      delete global[key]
    }
  })
})

describe('the homepage hub grid (#347)', () => {
  beforeEach(() => {
    vi.stubGlobal('React', React)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const category = (slug: string, name: string, count: number): PublishedCategory => ({
    count,
    description: '',
    name,
    order: 0,
    slug
  })
  const categories = [
    category('writing', 'Writing', 12),
    category('audio', 'Audio', 0),
    category('design', 'Design', 3),
    category('notebooks', 'Notebooks', 40)
  ]
  const browse = { items: [], page: 1, pageCount: 1, pageSize: 48 }

  it('lists the categories with a public listing that hold a tag, by name', () => {
    const tags = [{ category: 'writing' }, { category: 'design' }, { category: 'audio' }]
    expect(homepageHubs(categories, tags).map(hub => hub.slug)).toEqual(['design', 'writing'])
  })

  it('renders the grid only with hubs, so the homepage looks as before without tags', () => {
    const page = (tags: Array<{ category: string }>) =>
      renderToStaticMarkup(
        <HomePageRoute
          data={buildHomePageData({
            browse,
            categories,
            featured: [],
            latest: [],
            tags,
            totalCount: 0
          })}
        />
      )
    const withHubs = page([{ category: 'writing' }])
    expect(withHubs).toContain('id="categories"')
    expect(withHubs).toMatch(/href="\/products\/categories\/writing\/?"/u)
    expect(withHubs).not.toMatch(/href="\/products\/categories\/notebooks\/?"/u)
    expect(page([])).not.toContain('id="categories"')
  })
})

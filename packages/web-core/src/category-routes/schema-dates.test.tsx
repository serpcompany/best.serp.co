import { Package } from 'lucide-react'
import React, { isValidElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Category } from '../categories'
import type { WebsiteMetadata } from '../content-query'
import { CategoryRoutePage } from './category-page'
import { FeaturedCategoryRoutePage } from './featured-page'
import { resolveCollectionPageSchemaDates } from './schema-dates'

vi.hoisted(() => {
  process.env.SITE_ID = 'serp.software'
  process.env.NEXT_PUBLIC_SITE_ID = 'serp.software'
})

const category: Category = {
  description: 'Alpha listings.',
  icon: Package,
  name: 'Alpha',
  priority: 'medium',
  slug: 'alpha'
}

const websites: WebsiteMetadata[] = [
  {
    slug: 'older-alpha',
    name: 'Older Alpha',
    description: 'Older alpha listing.',
    website: 'https://older-alpha.example.com',
    category: 'alpha',
    categories: ['alpha'],
    publishedAt: '2026-01-01',
    featured: true
  },
  {
    slug: 'newer-alpha',
    name: 'Newer Alpha',
    description: 'Newer alpha listing.',
    website: 'https://newer-alpha.example.com',
    category: 'alpha',
    categories: ['alpha'],
    publishedAt: '2026-01-03',
    featured: true
  },
  {
    slug: 'beta',
    name: 'Beta',
    description: 'Beta listing.',
    website: 'https://beta.example.com',
    category: 'beta',
    categories: ['beta'],
    publishedAt: '2026-01-02'
  }
]

function JsonLd(_props: { data: Record<string, unknown> }) {
  return null
}

function NullComponent() {
  return null
}

function collectJsonLdData(node: ReactNode): Record<string, unknown>[] {
  if (Array.isArray(node)) {
    return node.flatMap(child => collectJsonLdData(child))
  }

  if (!isValidElement(node)) {
    return []
  }

  const props = node.props as { children?: ReactNode; data?: Record<string, unknown> }

  if (node.type === JsonLd && props.data) {
    return [props.data]
  }

  return collectJsonLdData(props.children)
}

function getCollectionPageData(node: ReactNode): Record<string, unknown> {
  const collectionPageData = collectJsonLdData(node).find(
    data => data['@type'] === 'CollectionPage'
  )

  if (!collectionPageData) {
    throw new Error('Expected CollectionPage JSON-LD data')
  }

  return collectionPageData
}

describe('collection page schema dates', () => {
  beforeEach(() => {
    vi.stubGlobal('React', React)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('uses source listing dates for category JSON-LD instead of the build clock', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2099-01-01T00:00:00.000Z'))

    const { element } = CategoryRoutePage({
      activeCategorySlugs: ['alpha'],
      allProjects: websites,
      category,
      featuredGuides: [],
      featuredProjects: websites.filter(website => website.featured === true),
      slots: {
        CategoryWebsitesList: NullComponent,
        ExternalResourcesSection: NullComponent,
        FeaturedGuidesSection: NullComponent,
        JsonLd,
        breadcrumb: null
      }
    })
    const data = getCollectionPageData(element)

    expect(data.datePublished).toBe('2026-01-01')
    expect(data.dateModified).toBe('2026-01-03')
    expect(JSON.stringify(data)).not.toContain('2099-01-01')
  })

  it('uses source listing dates for featured JSON-LD instead of the build clock', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2099-01-01T00:00:00.000Z'))

    const element = FeaturedCategoryRoutePage({
      activeCategorySlugs: ['alpha'],
      featuredGuides: [],
      featuredProjects: websites.filter(website => website.featured === true),
      slots: {
        CategoryWebsitesList: NullComponent,
        ExternalResourcesSection: NullComponent,
        FeaturedGuidesSection: NullComponent,
        JsonLd,
        breadcrumb: null,
        headingIcon: null
      }
    })
    const data = getCollectionPageData(element)

    expect(data.datePublished).toBe('2026-01-01')
    expect(data.dateModified).toBe('2026-01-03')
    expect(JSON.stringify(data)).not.toContain('2099-01-01')
  })

  it('omits schema dates when a collection has no published listings', () => {
    expect(resolveCollectionPageSchemaDates([])).toEqual({})
  })

  it('ignores invalid listing dates instead of normalizing them by rollover', () => {
    expect(
      resolveCollectionPageSchemaDates([
        {
          publishedAt: '2026-02-31'
        },
        {
          publishedAt: '2026-02-31T00:00:00Z'
        },
        {
          publishedAt: 'not-a-date'
        }
      ])
    ).toEqual({})
  })

  it('accepts valid date-time strings and emits canonical ISO schema values', () => {
    expect(
      resolveCollectionPageSchemaDates([
        {
          publishedAt: '2026-01-03T12:30:00Z'
        },
        {
          publishedAt: '2026-01-01'
        }
      ])
    ).toEqual({
      dateModified: '2026-01-03T12:30:00.000Z',
      datePublished: '2026-01-01'
    })
  })
})

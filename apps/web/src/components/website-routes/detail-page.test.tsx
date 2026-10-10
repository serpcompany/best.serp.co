import { isValidElement, type ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import type { PublishedBestPage } from '@/db/contracts'
import type { WebsiteDetailMetadata } from '../../lib/directory/content-query'
import { listingContentTree } from '../../lib/markdown/listing-content-tree'
import { DetailPageLayout } from '../layout/detail-page-layout'
import { BestPageCards } from '../taxonomy/best-page'
import { WebsiteContentSection } from '../website/website-content-section'
import { listingCategoryNames, WebsiteDetailRoutePage } from './detail-page'

function findElement(node: ReactNode, type: unknown): { props: Record<string, unknown> } | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, type)
      if (found) return found
    }
    return null
  }
  if (!isValidElement(node)) return null
  if (node.type === type) return node as { props: Record<string, unknown> }
  const props = node.props as Record<string, ReactNode>
  for (const value of Object.values(props)) {
    const found = findElement(value, type)
    if (found) return found
  }
  return null
}

describe('the listing detail page (#334)', () => {
  it('hands the body section the cached tree the catalog adapter attached', () => {
    const contentTree = listingContentTree('Cached body', false)
    const project: WebsiteDetailMetadata = {
      category: 'fixture-tools',
      content: 'Cached body',
      contentTree,
      description: 'A fixture listing.',
      name: 'Fixture',
      nextWebsite: null,
      previousWebsite: null,
      publishedAt: '2026-07-04T00:00:00.000Z',
      relatedWebsites: [],
      slug: 'fixture.test',
      website: 'https://fixture.test/'
    }
    const section = findElement(WebsiteDetailRoutePage({ project }), WebsiteContentSection)
    expect(section?.props.contentTree).toBe(contentTree)
    expect(section?.props.website).toBe(project)
  })
})

describe('the listing page in the taxonomy (#347)', () => {
  const project: WebsiteDetailMetadata = {
    categories: ['writing-tools', 'retired-looking'],
    category: 'writing-tools',
    description: 'A fixture listing.',
    name: 'Fixture',
    nextWebsite: null,
    previousWebsite: null,
    publishedAt: '2026-07-04T00:00:00.000Z',
    relatedWebsites: [],
    slug: 'fixture.test',
    tags: [{ name: 'Note Taking', slug: 'note-taking' }],
    website: 'https://fixture.test/'
  }
  const categoryNames = new Map([['writing-tools', 'Writing (from D1)']])
  const bestPage: PublishedBestPage = {
    category: null,
    heading: 'Best Note Taking Apps',
    hub: 'writing-tools',
    intro: '',
    keyword: 'note taking app',
    lastModifiedAt: '2026-10-01T00:00:00.000Z',
    listSize: 10,
    order: 0,
    poolSize: 4,
    slug: 'note-taking-app',
    tag: 'note-taking',
    title: 'Best Note Taking Apps'
  }

  it('names its categories from D1, the hub first, else by their checked-in names', () => {
    expect(listingCategoryNames(project, categoryNames)).toEqual([
      { name: 'Writing (from D1)', slug: 'writing-tools' },
      { name: 'Retired Looking', slug: 'retired-looking' }
    ])
  })

  it('puts the hub between the directory and the listing in the breadcrumb', () => {
    const layout = findElement(WebsiteDetailRoutePage({ categoryNames, project }), DetailPageLayout)
    expect(layout?.props.breadcrumbs).toEqual([
      { href: '/products/', label: 'Products' },
      { href: '/products/categories/writing-tools/', label: 'Writing (from D1)' },
      { label: 'Fixture' }
    ])
  })

  it('lists "Featured in" only when a best page shows the listing', () => {
    const featured = findElement(
      WebsiteDetailRoutePage({ categoryNames, featuredIn: [bestPage], project }),
      BestPageCards
    )
    expect(featured?.props.pages).toEqual([bestPage])
    expect(findElement(WebsiteDetailRoutePage({ categoryNames, project }), BestPageCards)).toBe(
      null
    )
  })
})

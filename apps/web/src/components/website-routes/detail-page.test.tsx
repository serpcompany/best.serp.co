import { isValidElement, type ReactNode } from 'react'
import { describe, expect, expectTypeOf, it } from 'vitest'
import type { PublishedBestPage } from '@/db/contracts'
import type { WebsiteDetailMetadata } from '../../lib/directory/content-query'
import { listingContentTree } from '../../lib/markdown/listing-content-tree'
import { DetailPageLayout } from '../layout/detail-page-layout'
import { JsonLd } from '../seo/json-ld'
import { BestPageCards } from '../taxonomy/best-page'
import { WebsiteContentSection } from '../website/website-content-section'
import { WebsiteDetailAside } from '../website/website-detail-header'
import { WebsiteFaqsSection } from '../website/website-faqs-section'
import { WebsiteRelatedProjects } from '../website/website-related-projects'
import {
  generateWebsiteDetailRouteMetadata,
  listingCategoryNames,
  WebsiteDetailRoutePage
} from './detail-page'

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
      publishedAt: '2026-07-04T00:00:00.000Z',
      relatedWebsites: [],
      slug: 'fixture.test',
      website: 'https://fixture.test/'
    }
    const section = findElement(WebsiteDetailRoutePage({ project }), WebsiteContentSection)
    expect(section?.props.contentTree).toBe(contentTree)
    expect(section?.props.website).toBe(project)
  })

  it('keeps the badge and the claim out of the header, under the content (#491)', () => {
    const claim = <button type="button">Claim this listing</button>
    const project: WebsiteDetailMetadata = {
      category: 'fixture-tools',
      description: 'A fixture listing.',
      name: 'Fixture',
      publishedAt: '2026-07-04T00:00:00.000Z',
      relatedWebsites: [],
      slug: 'fixture.test',
      website: 'https://fixture.test/'
    }
    const layout = findElement(WebsiteDetailRoutePage({ claim, project }), DetailPageLayout)
    expect(layout?.props.aside).toBeUndefined()
    const content = layout?.props.children as ReactNode
    expect(findElement(content, WebsiteFaqsSection)).not.toBeNull()
    const block = findElement(content, WebsiteDetailAside)
    expect(block?.props.claim).toBe(claim)
    expect(block?.props.website).toEqual({ slug: 'fixture.test' })
  })

  it('ends with the Alternatives section, with no "Browse more" (#519)', () => {
    const related = {
      description: 'Another.',
      name: 'Other',
      slug: 'other.test',
      website: 'https://other.test/'
    }
    const page = WebsiteDetailRoutePage({
      project: {
        category: 'fixture-tools',
        description: 'A fixture listing.',
        name: 'Fixture',
        publishedAt: '2026-07-04T00:00:00.000Z',
        relatedWebsites: [related],
        slug: 'fixture.test',
        website: 'https://fixture.test/'
      }
    })
    const titles: unknown[] = []
    const collect = (node: ReactNode): void => {
      if (Array.isArray(node)) {
        for (const child of node) collect(child)
        return
      }
      if (!isValidElement(node)) return
      const props = node.props as Record<string, ReactNode>
      if ('title' in props) titles.push(props.title)
      for (const value of Object.values(props)) collect(value)
    }
    collect(page)
    expect(titles).not.toContain('Browse more')
    // The layout's body column: the listing's own blocks, then the Alternatives section last.
    const body = findElement(page, DetailPageLayout)?.props.children as
      | { props: { children: ReactNode[] } }
      | undefined
    const last = (body?.props.children ?? []).filter(isValidElement).at(-1)
    expect(last?.type).toBe(WebsiteRelatedProjects)
    expect(last?.props).toEqual({ websites: [related] })
  })

  it('renders a listing with nothing related, without the related section (#378 review)', () => {
    const project: WebsiteDetailMetadata = {
      category: 'fixture-tools',
      description: 'A fixture listing alone in its category.',
      name: 'Fixture',
      publishedAt: '2026-07-04T00:00:00.000Z',
      relatedWebsites: [],
      slug: 'fixture.test',
      website: 'https://fixture.test/'
    }
    const page = WebsiteDetailRoutePage({ project })
    expect(findElement(page, DetailPageLayout)).not.toBeNull()
    expect(findElement(page, WebsiteRelatedProjects)).toBeNull()
    const related = {
      description: 'Another.',
      name: 'Other',
      slug: 'other.test',
      website: 'https://other.test/'
    }
    expect(
      findElement(
        WebsiteDetailRoutePage({ project: { ...project, relatedWebsites: [related] } }),
        WebsiteRelatedProjects
      )
    ).not.toBeNull()
  })
})

describe('the listing page in the taxonomy (#347)', () => {
  const project: WebsiteDetailMetadata = {
    categories: ['writing-tools', 'retired-looking'],
    category: 'writing-tools',
    description: 'A fixture listing.',
    name: 'Fixture',
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

describe('a listing names its hub as D1 does (#416)', () => {
  // D1 names the `audio` hub "Audio & Music"; cased from its slug it would read "Audio".
  const project: WebsiteDetailMetadata = {
    categories: ['audio', 'retired-hub'],
    category: 'audio',
    // Short enough that the meta description is padded with its category.
    description: 'Music.',
    name: 'Tunes',
    publishedAt: '2026-07-04T00:00:00.000Z',
    relatedWebsites: [],
    slug: 'fixture-tunes.test',
    website: 'https://fixture-tunes.test/'
  }
  const categoryNames = new Map([['audio', 'Audio & Music']])

  it('in its meta description and keywords', async () => {
    const metadata = await generateWebsiteDetailRouteMetadata(project, categoryNames)
    expect(metadata.description).toContain('Category: Audio & Music.')
    expect(metadata.keywords).toContain('Audio & Music')
    expect(JSON.stringify(metadata)).not.toMatch(/\bAudio\b(?! &)/u)
  })

  it('is titled with the listing pattern and leads its description with its words (#521)', async () => {
    const metadata = await generateWebsiteDetailRouteMetadata(project, categoryNames)
    expect(metadata.title).toBe('Tunes Review, Rating & Alternatives')
    expect(metadata.openGraph?.title).toBe('Tunes Review, Rating & Alternatives')
    expect(metadata.openGraph?.siteName).toBe('SERP Best')
    expect(metadata.description).toBe(
      'Tunes review, rating & alternatives. Music. Category: Audio & Music. Explore Tunes in the SERP Best directory.'
    )
  })

  it('requires the names, so tsc catches a caller that drops them (#421 review)', () => {
    expectTypeOf(generateWebsiteDetailRouteMetadata)
      .parameter(1)
      .toEqualTypeOf<ReadonlyMap<string, string>>()
  })

  it('in its JSON-LD: the breadcrumb and the application category', () => {
    const data = findElement(WebsiteDetailRoutePage({ categoryNames, project }), JsonLd)?.props
      .data as { '@graph': Array<Record<string, unknown>> }
    const node = (type: string) => data['@graph'].find(entry => entry['@type'] === type) ?? {}
    expect(node('SoftwareApplication').applicationCategory).toBe('Audio & Music')
    expect(
      (node('BreadcrumbList').itemListElement as Array<{ name: string }>).map(item => item.name)
    ).toContain('Audio & Music')
  })

  it('in its body, and names a category D1 no longer has from its slug', () => {
    const section = findElement(
      WebsiteDetailRoutePage({ categoryNames, project }),
      WebsiteContentSection
    )
    expect(section?.props.categories).toEqual([
      { name: 'Audio & Music', slug: 'audio' },
      { name: 'Retired Hub', slug: 'retired-hub' }
    ])
  })
})

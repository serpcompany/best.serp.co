import { describe, expect, it } from 'vitest'
import type { PublishedBestPage } from '@/db/contracts'
import { featuredInBestPages } from './featured-in'

function bestPage(
  slug: string,
  rule: { category?: string; tag?: string },
  size: { listSize?: number; poolSize: number }
): PublishedBestPage {
  return {
    category: rule.category ?? null,
    heading: slug,
    hub: rule.category ?? 'hub',
    intro: '',
    keyword: slug,
    lastModifiedAt: '2026-10-01T00:00:00.000Z',
    listSize: size.listSize ?? 10,
    order: 0,
    poolSize: size.poolSize,
    slug,
    tag: rule.tag ?? null,
    title: slug
  }
}

const slugs = (pages: PublishedBestPage[]) => pages.map(page => page.slug)

describe('"Featured in": the best pages that show a listing (#347)', () => {
  const listing = {
    category: 'writing',
    categories: ['writing', 'design'],
    tags: [{ slug: 'notes' }, { slug: 'docs' }]
  }

  it('names a page whose rule selects the listing only when it shows its whole pool', () => {
    const pages = [
      bestPage('notes-all', { tag: 'notes' }, { poolSize: 10 }),
      bestPage('notes-big', { tag: 'notes' }, { poolSize: 11 }),
      bestPage('docs-in-writing', { category: 'writing', tag: 'docs' }, { poolSize: 4 }),
      bestPage('docs-in-audio', { category: 'audio', tag: 'docs' }, { poolSize: 4 }),
      bestPage('design', { category: 'design' }, { poolSize: 3 }),
      bestPage('audio', { category: 'audio' }, { poolSize: 3 }),
      bestPage('other-tag', { tag: 'whiteboards' }, { poolSize: 2 })
    ]
    // A secondary category counts, as in the page's pool; categories alone come last.
    expect(slugs(featuredInBestPages(listing, pages))).toEqual([
      'notes-all',
      'docs-in-writing',
      'design'
    ])
  })

  it('names a pin within the shown entries first, and never a page that excludes the listing', () => {
    const pages = [
      bestPage('notes-big', { tag: 'notes' }, { poolSize: 40 }),
      bestPage('pinned-elsewhere', { tag: 'whiteboards' }, { poolSize: 40 }),
      bestPage('pinned-deep', { tag: 'notes' }, { listSize: 5, poolSize: 40 }),
      bestPage('excluded', { tag: 'notes' }, { poolSize: 3 }),
      bestPage('docs', { tag: 'docs' }, { poolSize: 2 })
    ]
    const marked = {
      ...listing,
      bestPageMarks: [
        { page: 'notes-big', position: 3 },
        { page: 'pinned-elsewhere', position: 1 },
        { page: 'pinned-deep', position: 6 },
        { page: 'excluded', position: null }
      ]
    }
    // A pin past the shown entries may be cut, like an unpinned listing in a large pool.
    expect(slugs(featuredInBestPages(marked, pages))).toEqual([
      'pinned-elsewhere',
      'notes-big',
      'docs'
    ])
  })

  it('names at most three, in the index order within a rank, and none without taxonomy data', () => {
    const pages = ['a', 'b', 'c', 'd'].map(slug =>
      bestPage(slug, { tag: 'notes' }, { poolSize: 5 })
    )
    expect(slugs(featuredInBestPages(listing, pages))).toEqual(['a', 'b', 'c'])
    expect(featuredInBestPages({ category: 'writing' }, pages)).toEqual([])
    // A page with no entry renders nothing to link.
    expect(
      featuredInBestPages(listing, [bestPage('empty', { tag: 'notes' }, { poolSize: 0 })])
    ).toEqual([])
  })
})

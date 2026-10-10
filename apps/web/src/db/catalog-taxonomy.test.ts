import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createDatabase } from './client'
import type { CatalogCacheEvent, CatalogDataCache, CatalogQueryEvent } from './contracts'
import {
  MemoryCatalogCache,
  SqliteD1,
  seedContractFixture,
  seedTaxonomyFixture
} from './test-support'

vi.mock('server-only', () => ({}))

const { createCatalogOperations } = await import('./catalog')

const now = () => new Date('2026-07-30T00:00:00.000Z')
const epoch = '1.2026-07-05T00:00:00.000Z'

/** The catalog's taxonomy reads (#341 design 3.1–3.5, #345) on `seedTaxonomyFixture`. */
describe('taxonomy reads (#345)', () => {
  let sqlite: SqliteD1

  beforeAll(() => {
    sqlite = new SqliteD1()
    seedContractFixture(sqlite)
    seedTaxonomyFixture(sqlite)
  })

  function operations(cache: CatalogDataCache = new MemoryCatalogCache()) {
    const events: Array<CatalogCacheEvent | CatalogQueryEvent> = []
    return {
      events,
      operations: createCatalogOperations({
        cache,
        client: createDatabase(sqlite.asD1Database()),
        clock: now,
        observe: event => events.push(event)
      })
    }
  }

  const queries = (events: Array<CatalogCacheEvent | CatalogQueryEvent>) =>
    events.flatMap(event => (event.event === 'd1_query' ? [event.queryShape] : []))

  it('counts each active tag under its hub, with its newest change', async () => {
    const { events, operations: catalog } = operations()
    expect(await catalog.getActiveTags()).toEqual([
      {
        category: 'primary',
        count: 4,
        description: 'Writing tools',
        // bravo's `CURRENT_TIMESTAMP`-format edit, the newest change among its listings.
        lastModifiedAt: '2026-07-20T10:30:00.000Z',
        name: 'Writers',
        order: 0,
        slug: 'writers'
      },
      {
        category: 'secondary',
        count: 4,
        description: '',
        lastModifiedAt: '2026-07-20T10:30:00.000Z',
        name: 'Editors',
        order: 1,
        slug: 'editors'
      },
      {
        category: 'empty',
        count: 0,
        description: '',
        lastModifiedAt: null,
        name: 'Idle',
        order: 2,
        slug: 'idle'
      }
    ])
    expect(await catalog.getTagBySlug('editors')).toMatchObject({ count: 4, slug: 'editors' })
    // A retired tag is not public.
    expect(await catalog.getTagBySlug('retired-tag')).toBeNull()
    expect(queries(events)).toEqual(['publication-version', 'tag-stats'])
  })

  it('pages a tag in name order, apart from a category with the same slug', async () => {
    const cache = new MemoryCatalogCache()
    const catalog = operations(cache).operations
    const writers = await catalog.getListingNamePage({ tag: 'writers' })
    expect(writers).toMatchObject({
      category: null,
      firstPublishedAt: '2026-07-04',
      lastModifiedAt: '2026-07-20T10:30:00.000Z',
      lastPublishedAt: '2026-07-05',
      pageCount: 1,
      tag: 'writers',
      total: 4
    })
    expect(writers.items.map(item => item.slug)).toEqual(['alpha', 'bravo', 'charlie', 'delta'])
    expect(await catalog.getListingNamePage({ tag: 'retired-tag' })).toMatchObject({
      items: [],
      total: 0
    })

    // A tag that shares a category's slug keeps its own name order and pages (design 3.5).
    sqlite.database.exec(`
      INSERT INTO tags (slug, name, category_id) SELECT 'secondary', 'Second', id FROM categories
        WHERE slug = 'primary';
      INSERT INTO listing_tags (listing_id, tag_id) SELECT 'serp-bravo', id FROM tags
        WHERE slug = 'secondary';
    `)
    try {
      const shared = operations(cache).operations
      const category = await shared.getListingNamePage({ category: 'secondary' })
      const tag = await shared.getListingNamePage({ tag: 'secondary' })
      expect(category.items.map(item => item.slug)).toEqual(['alpha', 'charlie', 'echo'])
      expect(tag.items.map(item => item.slug)).toEqual(['bravo'])
      expect([category.category, category.tag, tag.category, tag.tag]).toEqual([
        'secondary',
        null,
        null,
        'secondary'
      ])
      expect([...cache.values.keys()].filter(key => key.includes('secondary')).sort()).toEqual([
        `catalog-name-order:v8:${epoch}:c:secondary`,
        `catalog-name-order:v8:${epoch}:t:secondary`,
        `catalog-name-page:v8:${epoch}:c:secondary:48:1`,
        `catalog-name-page:v8:${epoch}:t:secondary:48:1`
      ])
      // Warm: both come from the cache, still apart.
      const warm = operations(cache)
      expect(
        (await warm.operations.getListingNamePage({ tag: 'secondary' })).items.map(
          item => item.slug
        )
      ).toEqual(['bravo'])
      expect(queries(warm.events)).toEqual(['publication-version'])
    } finally {
      sqlite.database.exec(`
        DELETE FROM listing_tags WHERE tag_id = (SELECT id FROM tags WHERE slug = 'secondary');
        DELETE FROM tags WHERE slug = 'secondary';
      `)
    }
    await expect(
      catalog.getListingNamePage({ category: 'primary', tag: 'writers' } as never)
    ).rejects.toThrow('not both')
  })

  it('indexes each public best page with its pool size and newest change', async () => {
    const { events, operations: catalog } = operations()
    const pages = await catalog.getBestPages()
    expect(pages).toEqual([
      {
        category: null,
        heading: 'The best writers',
        hub: 'primary',
        intro: 'Writers, ranked.',
        keyword: 'writers',
        lastModifiedAt: '2026-07-20T10:30:00.000Z',
        listSize: 5,
        order: 0,
        // The tag's 4, less charlie (excluded), plus echo (pinned from outside the tag).
        poolSize: 4,
        slug: 'best-writers',
        tag: 'writers',
        title: 'Best Writers'
      },
      {
        category: 'primary',
        heading: 'The best primary',
        hub: 'primary',
        intro: '',
        keyword: 'primary',
        // bravo, the newest change, is excluded.
        lastModifiedAt: '2026-07-05T00:00:00.000Z',
        listSize: 5,
        order: 1,
        poolSize: 4,
        slug: 'best-primary',
        tag: null,
        title: 'Best Primary'
      },
      {
        category: 'secondary',
        heading: 'The best editors in secondary',
        hub: 'secondary',
        intro: '',
        keyword: 'editors in secondary',
        // bravo is pinned, though it is not in the category.
        lastModifiedAt: '2026-07-20T10:30:00.000Z',
        listSize: 5,
        order: 2,
        poolSize: 4,
        slug: 'best-editors-in-secondary',
        tag: 'editors',
        title: 'Best Editors in Secondary'
      },
      {
        category: 'empty',
        heading: 'The best idle',
        hub: 'empty',
        intro: '',
        keyword: 'idle',
        lastModifiedAt: '2026-07-02T00:00:00.000Z',
        listSize: 5,
        order: 3,
        poolSize: 0,
        slug: 'best-idle',
        tag: null,
        title: 'Best Idle'
      }
    ])
    // The retired tag's page and the inactive page are not public.
    expect(await catalog.getBestPageBySlug('best-retired-tag')).toBeNull()
    expect(await catalog.getBestPageBySlug('best-inactive')).toBeNull()
    expect(queries(events)).toEqual(['publication-version', 'tag-stats', 'best-index'])
  })

  it('ranks pins, then tag centrality, then hosted logos, then names, within the pool', async () => {
    const { events, operations: catalog } = operations()
    const slugs = async (page: string) =>
      (await catalog.getBestPageItems(page)).map(item => item.slug)
    // Pins first (echo from outside the tag); charlie excluded; bravo's hosted logo before alpha.
    const writers = await catalog.getBestPageItems('best-writers')
    expect(writers.map(item => [item.slug, item.blurb, item.linkRel])).toEqual([
      ['delta', 'Delta leads.', 'follow'],
      ['echo', undefined, 'follow'],
      ['bravo', undefined, 'follow'],
      ['alpha', undefined, 'follow']
    ])
    expect(writers[2]).toMatchObject({
      category: 'primary',
      media: { logo: 'best.serp.co/listings/bravo/logo/0123456789abcdef.png' }
    })
    // A category alone: every member, less bravo (excluded), by name.
    expect(await slugs('best-primary')).toEqual(['alpha', 'charlie', 'delta', 'echo'])
    // A tag within a category: bravo pinned from outside the category, then centrality.
    expect(await slugs('best-editors-in-secondary')).toEqual(['bravo', 'alpha', 'echo', 'charlie'])
    expect(await slugs('best-idle')).toEqual([])
    // Every page shows min(listSize, poolSize).
    for (const page of await catalog.getBestPages()) {
      expect(await slugs(page.slug), page.slug).toHaveLength(Math.min(page.listSize, page.poolSize))
    }
    const itemQueries = queries(events).filter(shape => shape === 'best-page-items')
    // A page that is not public, or has no entries, never reaches D1.
    for (const page of ['best-retired-tag', 'best-inactive', 'missing', 'best-idle']) {
      expect(await catalog.getBestPageItems(page), page).toEqual([])
    }
    expect(queries(events).filter(shape => shape === 'best-page-items')).toEqual(itemQueries)
  })

  it("caches a best page's entries per epoch, and reads corrupt entries again", async () => {
    const cache = new MemoryCatalogCache()
    const cold = operations(cache)
    const items = await cold.operations.getBestPageItems('best-primary')
    expect(items).toHaveLength(4)
    expect([...cache.values.keys()]).toContain(`catalog-best-items:v8:${epoch}:best-primary`)
    const warm = operations(cache)
    expect(await warm.operations.getBestPageItems('best-primary')).toEqual(items)
    expect(queries(warm.events)).toEqual(['publication-version'])
    expect(warm.events).toContainEqual({
      event: 'catalog_cache',
      operation: 'best-page-items',
      state: 'hit'
    })

    // A corrupt entry is read again from D1.
    const corrupt = new MemoryCatalogCache()
    corrupt.values.set(`catalog-best-items:v8:${epoch}:best-primary`, { items: 'wrong' })
    corrupt.values.set(`catalog-best-index:v8:${epoch}`, { pages: [{ slug: 'x' }] })
    const recovered = operations(corrupt)
    expect(await recovered.operations.getBestPageItems('best-primary')).toEqual(items)
    expect(recovered.events).toContainEqual({
      event: 'catalog_cache',
      operation: 'best-index',
      state: 'corrupt'
    })
  })

  it('follows a moved taxonomy URL to its active target, kind by kind', async () => {
    const catalog = operations().operations
    expect(await catalog.getTaxonomyRedirect('category', 'old-hub')).toEqual({
      kind: 'category',
      slug: 'secondary'
    })
    expect(await catalog.getTaxonomyRedirect('category', 'old-tag')).toEqual({
      kind: 'tag',
      slug: 'writers'
    })
    expect(await catalog.getTaxonomyRedirect('category', 'old-best')).toEqual({
      kind: 'best',
      slug: 'best-writers'
    })
    expect(await catalog.getTaxonomyRedirect('category', 'old-other')).toEqual({
      kind: 'directory',
      slug: null
    })
    expect(await catalog.getTaxonomyRedirect('tag', 'old-writers')).toEqual({
      kind: 'tag',
      slug: 'writers'
    })
    expect(await catalog.getTaxonomyRedirect('best', 'old-best-writers')).toEqual({
      kind: 'best',
      slug: 'best-writers'
    })
    // A retired target, a best page whose tag is retired (not in the best index, so a 404),
    // another kind's source, or no row: nothing to follow.
    expect(await catalog.getTaxonomyRedirect('category', 'old-retired-tag')).toBeNull()
    expect(await catalog.getBestPageBySlug('best-retired-tag')).toBeNull()
    expect(await catalog.getTaxonomyRedirect('category', 'old-best-retired-tag')).toBeNull()
    expect(await catalog.getTaxonomyRedirect('tag', 'old-hub')).toBeNull()
    expect(await catalog.getTaxonomyRedirect('category', 'missing')).toBeNull()
  })

  it('carries active tags on the detail and ranks related listings by shared tags', async () => {
    const { events, operations: catalog } = operations()
    const start = sqlite.statements.length
    const bravo = await catalog.getListingBySlug('bravo')
    // Epoch, detail, related, previous, next.
    expect(sqlite.statements.length - start).toBe(5)
    // Most central first, then slug; the retired tag is left out.
    expect(bravo?.tags).toEqual([
      { name: 'Editors', slug: 'editors' },
      { name: 'Writers', slug: 'writers' }
    ])
    // alpha and charlie share both tags, delta and echo one (delta's retired tag doesn't
    // count); within a score, the names after bravo's come first, then the wrap to the start.
    expect(bravo?.relatedWebsites.map(item => item.slug)).toEqual([
      'charlie',
      'alpha',
      'delta',
      'echo'
    ])
    expect(queries(events)).toContain('related-shared-tags')
    // From echo, every candidate sorts before it, so the order wraps to the start. Its one tag
    // yields three, so its hub (`primary`) fills the fourth slot in the same statement, after them.
    expect(
      (await catalog.getListingBySlug('echo'))?.relatedWebsites.map(item => item.slug)
    ).toEqual(['alpha', 'bravo', 'charlie', 'delta'])
    // Neighbours differ: the "same three" (#331) no longer repeat.
    const alpha = await catalog.getListingBySlug('alpha')
    expect(alpha?.relatedWebsites.map(item => item.slug)).toEqual([
      'bravo',
      'charlie',
      'delta',
      'echo'
    ])
  })

  it('scores related listings on the three most central tags only, and fills from the hub', async () => {
    // bravo's active tags, most central first: editors and writers (0), fringe-a (5), fringe-b (9).
    // delta shares writers, fringe-a and fringe-b; fringe-b is bravo's fourth, so it doesn't count.
    sqlite.database.exec(`
      INSERT INTO tags (slug, name, category_id) SELECT 'fringe-a', 'Fringe A', id FROM categories
        WHERE slug = 'primary';
      INSERT INTO tags (slug, name, category_id) SELECT 'fringe-b', 'Fringe B', id FROM categories
        WHERE slug = 'primary';
      INSERT INTO tags (slug, name, category_id) SELECT 'solo', 'Solo', id FROM categories
        WHERE slug = 'secondary';
      INSERT INTO listing_tags (listing_id, tag_id, sort_order)
        SELECT m.listing_id, t.id, m.sort_order FROM (
          SELECT 'serp-bravo' AS listing_id, 'fringe-a' AS tag, 5 AS sort_order
          UNION ALL SELECT 'serp-bravo', 'fringe-b', 9
          UNION ALL SELECT 'serp-delta', 'fringe-a', 0
          UNION ALL SELECT 'serp-delta', 'fringe-b', 0
        ) m JOIN tags t ON t.slug = m.tag;
    `)
    try {
      const catalog = operations().operations
      // Scored on all four, delta (3) would lead. On three it ties with alpha and charlie (2), and
      // the keyset from bravo's name orders the tie: charlie, delta, then the wrap to alpha.
      expect(
        (await catalog.getListingBySlug('bravo'))?.relatedWebsites.map(item => item.slug)
      ).toEqual(['charlie', 'delta', 'alpha', 'echo'])

      // A tag no other public listing has: all four come from the hub, after its own name first.
      sqlite.database.exec(`
        DELETE FROM listing_tags WHERE listing_id = 'serp-charlie';
        INSERT INTO listing_tags (listing_id, tag_id) SELECT 'serp-charlie', id FROM tags
          WHERE slug = 'solo';
      `)
      const fresh = operations()
      const start = sqlite.statements.length
      const charlie = await fresh.operations.getListingBySlug('charlie')
      expect(charlie?.tags).toEqual([{ name: 'Solo', slug: 'solo' }])
      expect(charlie?.relatedWebsites.map(item => item.slug)).toEqual([
        'delta',
        'echo',
        'alpha',
        'bravo'
      ])
      expect(sqlite.statements.length - start).toBe(5)
      expect(queries(fresh.events)).toContain('related-shared-tags')
    } finally {
      sqlite.database.exec(`
        DELETE FROM listing_tags WHERE listing_id = 'serp-charlie';
        INSERT INTO listing_tags (listing_id, tag_id, sort_order)
          SELECT 'serp-charlie', id, CASE slug WHEN 'writers' THEN 0 ELSE 1 END FROM tags
          WHERE slug IN ('writers', 'editors');
        DELETE FROM listing_tags
          WHERE tag_id IN (SELECT id FROM tags WHERE slug IN ('fringe-a', 'fringe-b', 'solo'));
        DELETE FROM tags WHERE slug IN ('fringe-a', 'fringe-b', 'solo');
      `)
    }
  })

  it('finds listings by an active tag name or slug, never a retired one', async () => {
    const catalog = operations().operations
    const slugs = async (query: string) =>
      (await catalog.searchListings(query, 20)).map(item => item.slug)
    expect(await slugs('writers')).toEqual(['alpha', 'bravo', 'charlie', 'delta'])
    expect(await slugs('EDITORS')).toEqual(['alpha', 'bravo', 'charlie', 'echo'])
    // Every term must match: a tag term and a category term together.
    expect(await slugs('editors primary')).toEqual(['alpha', 'bravo', 'charlie', 'echo'])
    expect(await slugs('writers secondary')).toEqual(['alpha', 'charlie'])
    expect(await slugs('retired')).toEqual([])
    expect(await slugs('idle')).toEqual([])
  })
})

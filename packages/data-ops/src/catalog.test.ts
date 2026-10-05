import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { catalogEpochToken, readCatalogEpoch } from './catalog-epoch'
import { createDatabase } from './client'
import type { CatalogCacheEvent, CatalogDataCache, CatalogQueryEvent } from './contracts'
import { MemoryCatalogCache, SqliteD1, seedContractFixture } from './test-support'

vi.mock('server-only', () => ({}))

const { createCatalogOperations } = await import('./catalog')

const now = () => new Date('2026-07-30T00:00:00.000Z')
/** Cache-key epoch of the fixture at `now`: version, then the newest public `published_at`. */
const epoch = (version: number) => `${version}.2026-07-05T00:00:00.000Z`

describe('shared catalog data operations', () => {
  let sqlite: SqliteD1

  beforeAll(() => {
    sqlite = new SqliteD1()
    seedContractFixture(sqlite)
  })

  beforeEach(() => {
    sqlite.database.prepare('UPDATE publication_state SET version = 1').run()
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

  it('preserves catalog ordering, pagination, and empty pages', async () => {
    const catalog = operations().operations
    expect((await catalog.getPublishedListings()).map(item => item.slug)).toEqual([
      'alpha',
      'bravo',
      'charlie',
      'delta',
      'echo'
    ])
    const page = await catalog.getPublishedListingPage(2, 2)
    expect(page).toMatchObject({ page: 2, pageSize: 2, total: 5 })
    expect(page.items.map(item => item.slug)).toEqual(['charlie', 'delta'])
    expect((await catalog.getPublishedListingPage(99, 2)).items).toEqual([])
  })

  it('keeps summary operations away from detail content and relationship tables', async () => {
    const start = sqlite.statements.length
    await operations().operations.getPublishedListingPage(1, 3)
    const statements = sqlite.statements.slice(start)
    expect(statements).toHaveLength(2)
    for (const { sql } of statements) {
      expect(sql).not.toContain('listing_resource_links')
      expect(sql).not.toContain('listing_faqs')
      expect(sql).not.toMatch(/\bl\.content\b/u)
    }
    expect(statements.some(statement => statement.sql.includes("m.kind = 'logo'"))).toBe(true)
  })

  it('loads one detail projection with deterministic related and boundary navigation', async () => {
    const catalog = operations().operations
    const detail = await catalog.getListingBySlug('charlie')
    expect(detail).toMatchObject({
      slug: 'charlie',
      content: 'charlie detail content',
      previousWebsite: { slug: 'bravo' },
      nextWebsite: { slug: 'delta' }
    })
    expect(detail?.resourceLinks).toEqual([
      { label: 'Documentation', url: 'https://docs.example/serp-charlie' }
    ])
    expect(detail?.media?.images).toEqual(['https://assets.example/serp-charlie-image.png'])
    expect(detail?.relatedWebsites.map(item => item.slug)).toEqual([
      'alpha',
      'echo',
      'bravo',
      'delta'
    ])
    expect((await catalog.getListingBySlug('alpha'))?.previousWebsite).toBeNull()
    expect((await catalog.getListingBySlug('echo'))?.nextWebsite).toBeNull()
    expect(await catalog.getListingBySlug('future')).toBeNull()
  })

  it('ranks single-category related listings from the category members', async () => {
    const { events, operations: catalog } = operations()
    const detail = await catalog.getListingBySlug('bravo')
    expect(detail?.relatedWebsites.map(item => item.slug)).toEqual([
      'alpha',
      'charlie',
      'delta',
      'echo'
    ])
    expect(detail?.relatedWebsites[0]?.media?.logo).toBe(
      'https://assets.example/serp-alpha-logo.png'
    )
    expect(
      events.some(
        event =>
          event.event === 'd1_query' && event.queryShape === 'related-single-category-members'
      )
    ).toBe(true)
  })

  it('pages listings in locale name order for the directory and for one category', async () => {
    // Upper-case sorts before lower-case in SQLite's binary order; the directory has always
    // used locale order, where "Echo" follows "delta".
    sqlite.database.prepare("UPDATE listings SET name = 'Echo listing' WHERE slug = 'echo'").run()
    try {
      const catalog = operations().operations
      const first = await catalog.getListingNamePage({ page: 1, pageSize: 2 })
      expect(first).toMatchObject({
        category: null,
        firstPublishedAt: '2026-07-03',
        lastPublishedAt: '2026-07-05',
        page: 1,
        pageCount: 3,
        pageSize: 2,
        total: 5
      })
      expect(first.items.map(item => item.slug)).toEqual(['alpha', 'bravo'])
      expect(
        (await catalog.getListingNamePage({ page: 3, pageSize: 2 })).items.map(item => item.slug)
      ).toEqual(['echo'])
      expect((await catalog.getListingNamePage({ page: 9, pageSize: 2 })).items).toEqual([])

      const secondary = await catalog.getListingNamePage({ category: 'secondary' })
      expect(secondary).toMatchObject({ category: 'secondary', pageCount: 1, pageSize: 48 })
      expect(secondary.items.map(item => item.slug)).toEqual(['alpha', 'charlie', 'echo'])

      expect(await catalog.getListingNamePage({ category: 'missing' })).toMatchObject({
        firstPublishedAt: null,
        items: [],
        pageCount: 1,
        total: 0
      })
    } finally {
      sqlite.database.prepare("UPDATE listings SET name = 'echo listing' WHERE slug = 'echo'").run()
    }
  })

  it('serves name pages from summary projections and caches them by epoch', async () => {
    const cache = new MemoryCatalogCache()
    const start = sqlite.statements.length
    await operations(cache).operations.getListingNamePage({ page: 2, pageSize: 2 })
    const coldStatements = sqlite.statements.slice(start)
    expect(coldStatements).toHaveLength(3)
    for (const { sql } of coldStatements) {
      expect(sql).not.toContain('listing_resource_links')
      expect(sql).not.toContain('listing_faqs')
      expect(sql).not.toMatch(/\bl\.content\b/u)
    }

    const warm = operations(cache)
    const warmStart = sqlite.statements.length
    const page = await warm.operations.getListingNamePage({ page: 2, pageSize: 2 })
    expect(page.items.map(item => item.slug)).toEqual(['charlie', 'delta'])
    // Only the epoch probe reaches D1.
    expect(sqlite.statements.slice(warmStart)).toHaveLength(1)
    expect(warm.events).toContainEqual({
      event: 'catalog_cache',
      operation: 'listing-name-page',
      state: 'hit'
    })
  })

  it('turns caches over when a scheduled listing becomes public without a publication', async () => {
    const cache = new MemoryCatalogCache()
    const before = await operations(cache).operations.getShellStats()
    const later = createCatalogOperations({
      cache,
      client: createDatabase(sqlite.asD1Database()),
      clock: () => new Date('2027-01-02T00:00:00.000Z'),
      observe: () => {}
    })
    const after = await later.getShellStats()
    expect(before.listingCount).toBe(5)
    expect(after.listingCount).toBe(6)
    expect(after.publicationVersion).toBe(before.publicationVersion)
    expect((await later.getListingNamePage()).items.map(item => item.slug)).toContain('future')
    expect([...cache.values.keys()]).toContain('catalog-shell:v4:1.2027-01-01T00:00:00.000Z')
  })

  it('reads the catalog epoch for the Worker edge cache with query telemetry', async () => {
    const events: CatalogQueryEvent[] = []
    const epochAt = (asOf: string) =>
      readCatalogEpoch({
        asOf,
        client: createDatabase(sqlite.asD1Database()),
        observe: event => {
          if (event.event === 'd1_query') events.push(event)
        }
      })
    const current = await epochAt('2026-07-30T00:00:00.000Z')
    expect(current).toEqual({ effectiveAt: '2026-07-05T00:00:00.000Z', version: 1 })
    expect(catalogEpochToken(current)).toBe(epoch(1))
    expect(catalogEpochToken(await epochAt('2020-01-01T00:00:00.000Z'))).toBe('1.none')
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ operation: 'publication-version', success: true })
  })

  it('preserves canonical redirects and rejects missing targets', async () => {
    const catalog = operations().operations
    expect(await catalog.getCanonicalSlugForRedirect('old-bravo')).toBe('bravo')
    expect(await catalog.getCanonicalSlugForRedirect('missing')).toBeNull()
  })

  it('keeps search and autocomplete summary-only', async () => {
    const { operations: catalog } = operations()
    const start = sqlite.statements.length
    const search = await catalog.searchListings('charlie', 10)
    const autocomplete = await catalog.getAutocomplete('br', 8)
    const statements = sqlite.statements.slice(start)

    expect(search.map(item => item.slug)).toEqual(['charlie'])
    expect(autocomplete.map(item => item.slug)).toEqual(['bravo'])
    for (const { sql } of statements) {
      expect(sql).not.toContain('listing_resource_links')
      expect(sql).not.toContain('listing_faqs')
      expect(sql).not.toContain("m.kind != 'logo'")
    }
  })

  it('caches shell counts by publication version', async () => {
    const cache = new MemoryCatalogCache()
    const coldCatalog = operations(cache)
    const first = await coldCatalog.operations.getShellStats()
    const shellQueriesAfterFirst = coldCatalog.events.filter(
      event => event.event === 'd1_query' && event.queryShape === 'shell-stats'
    )
    const secondCatalog = operations(cache)
    const second = await secondCatalog.operations.getShellStats()

    expect(first).toEqual(second)
    expect(first.featuredCount).toBe(2)
    expect(first.listingCount).toBe(5)
    expect(first.categories.map(category => [category.slug, category.count])).toEqual([
      ['primary', 5],
      ['secondary', 3],
      ['empty', 0]
    ])
    expect(shellQueriesAfterFirst).toHaveLength(1)
    expect(
      secondCatalog.events.filter(
        event => event.event === 'd1_query' && event.queryShape === 'shell-stats'
      )
    ).toHaveLength(0)
    expect(secondCatalog.events).toContainEqual({
      event: 'catalog_cache',
      operation: 'shell-stats',
      state: 'hit'
    })

    sqlite.database.prepare('UPDATE publication_state SET version = 2 WHERE id = 1').run()
    const versionedCatalog = operations(cache)
    const versioned = await versionedCatalog.operations.getShellStats()
    expect(versioned.publicationVersion).toBe(2)
    expect(
      versionedCatalog.events.filter(
        event => event.event === 'd1_query' && event.queryShape === 'shell-stats'
      )
    ).toHaveLength(1)
    expect([...cache.values.keys()].sort()).toEqual([
      `catalog-shell:v4:${epoch(1)}`,
      `catalog-shell:v4:${epoch(2)}`
    ])
  })

  it('falls back to live D1 when cached shell data is corrupt or unavailable', async () => {
    const corrupt = new MemoryCatalogCache()
    corrupt.values.set(`catalog-shell:v4:${epoch(1)}`, { featuredCount: 'wrong' })
    const corruptCatalog = operations(corrupt)
    expect((await corruptCatalog.operations.getShellStats()).featuredCount).toBe(2)
    expect(corruptCatalog.events).toContainEqual({
      event: 'catalog_cache',
      operation: 'shell-stats',
      state: 'corrupt'
    })

    const unavailable = {
      async get() {
        throw new Error('cache unavailable')
      },
      async put() {
        throw new Error('cache unavailable')
      }
    }
    const unavailableCatalog = operations(unavailable)
    expect((await unavailableCatalog.operations.getShellStats()).featuredCount).toBe(2)
    expect(unavailableCatalog.events).toContainEqual({
      event: 'catalog_cache',
      operation: 'shell-stats',
      state: 'error'
    })
    expect(unavailableCatalog.events).toContainEqual({
      event: 'catalog_cache',
      operation: 'shell-stats',
      state: 'write-error'
    })
  })

  it('caches stable published summaries and details across operation instances', async () => {
    const cache = new MemoryCatalogCache()
    const cold = operations(cache)
    const listings = await cold.operations.getPublishedListings()
    const detail = await cold.operations.getListingBySlug('charlie')

    expect(listings).toHaveLength(5)
    expect(detail?.relatedWebsites.map(item => item.slug)).toEqual([
      'alpha',
      'echo',
      'bravo',
      'delta'
    ])
    expect([...cache.ttlSeconds.values()]).toEqual([86400, 86400])
    expect(
      cold.events.filter(
        event => event.event === 'd1_query' && event.queryShape === 'published-summaries'
      )
    ).toHaveLength(1)
    expect(
      cold.events.filter(
        event => event.event === 'd1_query' && event.queryShape === 'listing-detail'
      )
    ).toHaveLength(1)

    const warm = operations(cache)
    expect(await warm.operations.getPublishedListings()).toEqual(listings)
    expect(await warm.operations.getListingBySlug('charlie')).toEqual(detail)
    expect(
      (await warm.operations.getPublishedListingPage(2, 2)).items.map(item => item.slug)
    ).toEqual(['charlie', 'delta'])
    expect(
      (await warm.operations.getListingsByCategory('secondary')).map(item => item.slug)
    ).toEqual(['alpha', 'charlie', 'echo'])
    expect((await warm.operations.getFeaturedListings()).map(item => item.slug)).toEqual([
      'alpha',
      'bravo'
    ])
    expect((await warm.operations.getLatestListings(2)).map(item => item.slug)).toEqual([
      'alpha',
      'bravo'
    ])
    expect(await warm.operations.getSitemapListings()).toEqual(listings)
    expect(
      warm.events.filter(
        event =>
          event.event === 'd1_query' &&
          (event.operation === 'published-summaries' || event.operation === 'listing-detail')
      )
    ).toHaveLength(0)
    expect(warm.events).toContainEqual({
      event: 'catalog_cache',
      operation: 'published-summaries',
      state: 'hit'
    })
    expect(warm.events).toContainEqual({
      event: 'catalog_cache',
      operation: 'listing-detail',
      state: 'hit'
    })
  })

  it('invalidates catalog caches by publication version and rejects corrupt entries', async () => {
    const cache = new MemoryCatalogCache()
    const cold = operations(cache)
    await cold.operations.getPublishedListings()
    await cold.operations.getListingBySlug('charlie')

    sqlite.database.prepare('UPDATE publication_state SET version = 2 WHERE id = 1').run()
    const versioned = operations(cache)
    await versioned.operations.getPublishedListings()
    await versioned.operations.getListingBySlug('charlie')
    expect(
      versioned.events.filter(
        event =>
          event.event === 'd1_query' &&
          (event.queryShape === 'published-summaries' || event.queryShape === 'listing-detail')
      )
    ).toHaveLength(2)

    const corrupt = new MemoryCatalogCache()
    corrupt.values.set(`catalog-published:v4:${epoch(2)}`, { items: 'wrong' })
    corrupt.values.set(`catalog-detail:v4:${epoch(2)}:charlie`, { detail: 'wrong' })
    const recovered = operations(corrupt)
    expect(await recovered.operations.getPublishedListings()).toHaveLength(5)
    expect((await recovered.operations.getListingBySlug('charlie'))?.slug).toBe('charlie')
    expect(recovered.events).toContainEqual({
      event: 'catalog_cache',
      operation: 'published-summaries',
      state: 'corrupt'
    })
    expect(recovered.events).toContainEqual({
      event: 'catalog_cache',
      operation: 'listing-detail',
      state: 'corrupt'
    })
  })

  it('emits attributable query metadata without SQL, bindings, or visitor data', async () => {
    const { events, operations: catalog } = operations()
    await catalog.getPublishedListings()
    const queryEvent = events.find(
      (event): event is CatalogQueryEvent =>
        event.event === 'd1_query' && event.queryShape === 'published-summaries'
    )
    expect(queryEvent).toMatchObject({
      event: 'd1_query',
      operation: 'published-summaries',
      queryShape: 'published-summaries',
      rowsWritten: 0,
      success: true
    })
    expect(queryEvent).not.toHaveProperty('sql')
    expect(queryEvent).not.toHaveProperty('bindings')
    expect(queryEvent).not.toHaveProperty('requestId')
  })
})

describe('listing link rel, verified owner, and unpublished state (#62)', () => {
  function catalogFor(sqlite: SqliteD1) {
    return createCatalogOperations({
      cache: new MemoryCatalogCache(),
      client: createDatabase(sqlite.asD1Database()),
      clock: now,
      observe: () => {}
    })
  }

  function seeded(): SqliteD1 {
    const sqlite = new SqliteD1()
    seedContractFixture(sqlite)
    sqlite.database.exec(`
      INSERT INTO users (id, name, email) VALUES ('owner', 'Owner', 'owner@example.com');
      UPDATE listings SET link_rel = 'sponsored' WHERE slug = 'delta';
      INSERT INTO listing_owners (listing_id, user_id, verified_via, verified_at)
        VALUES ('serp-delta', 'owner', 'badge_claim', '2026-07-01T00:00:00.000Z');
      UPDATE listings SET is_active = 0 WHERE slug = 'echo';
    `)
    return sqlite
  }

  it('renders listings as follow by default and derives the owner badge from listing_owners', async () => {
    const sqlite = seeded()
    const catalog = catalogFor(sqlite)
    const charlie = await catalog.getListingBySlug('charlie')
    expect(charlie).toMatchObject({ linkRel: 'follow' })
    expect(charlie?.verifiedOwner).toBeUndefined()
    expect(await catalog.getListingBySlug('delta')).toMatchObject({
      linkRel: 'sponsored',
      verifiedOwner: true
    })

    sqlite.database.exec(
      "UPDATE listing_owners SET revoked_at = '2026-07-02', revoked_reason = 'badge_removed'"
    )
    expect((await catalogFor(sqlite).getListingBySlug('delta'))?.verifiedOwner).toBeUndefined()
  })

  it('tells an unpublished listing (410) from a live, scheduled, or unknown slug', async () => {
    const catalog = catalogFor(seeded())
    expect(await catalog.getListingBySlug('echo')).toBeNull()
    expect(await catalog.getUnpublishedListing('echo')).toEqual({
      category: 'primary',
      name: 'echo listing',
      slug: 'echo'
    })
    for (const slug of ['charlie', 'future', 'missing']) {
      expect(await catalog.getUnpublishedListing(slug), slug).toBeNull()
    }
    expect((await catalog.getPublishedListings()).map(item => item.slug)).not.toContain('echo')
    expect(await catalog.searchListings('echo')).toEqual([])
  })
})

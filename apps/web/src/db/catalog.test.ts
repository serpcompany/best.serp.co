import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  catalogEpochToken,
  isUnpublishedListingSlug,
  legacyRootTarget,
  parseCatalogEpochToken,
  readCatalogEpoch,
  shareCatalogEpochToken,
  sharedCatalogEpoch
} from './catalog-epoch'
import { createDatabase } from './client'
import type { CatalogCacheEvent, CatalogDataCache, CatalogQueryEvent } from './contracts'
import {
  MemoryCatalogCache,
  SqliteD1,
  seedContractFixture,
  seedTaxonomyFixture
} from './test-support'

vi.mock('server-only', () => ({}))

const { createCatalogOperations, MAX_SEARCH_LIMIT, normalizeSearchQuery } = await import(
  './catalog'
)

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
    const page = await catalog.getListingNamePage({ page: 2, pageSize: 2 })
    expect(page).toMatchObject({ page: 2, pageCount: 3, pageSize: 2, total: 5 })
    expect(page.items.map(item => item.slug)).toEqual(['charlie', 'delta'])
    expect((await catalog.getListingNamePage({ page: 99, pageSize: 2 })).items).toEqual([])
  })

  it('keeps summary operations away from detail content and relationship tables', async () => {
    const start = sqlite.statements.length
    await operations().operations.getLatestListings(3)
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
    // The listing's FAQs, in order (#105).
    expect(detail?.faqs).toEqual([
      { answer: 'Answer for serp-charlie', question: 'Question for serp-charlie' }
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

  it('links every public listing to its neighbours in publication order, at every boundary', async () => {
    // The older-date branch of `next` has no `asOf` bound of its own since #314 (the current
    // listing is public, so older ones are too). Each branch, both directions: across a
    // publication date, to the next display order on one date, the slug tie on one date and
    // display order, and both ends. With the clock before alpha's date, alpha is not public yet,
    // and `future` never is.
    const orders: Record<string, string[]> = {
      '2026-07-30T00:00:00.000Z': ['alpha', 'bravo', 'charlie', 'delta', 'echo'],
      '2026-07-04T12:00:00.000Z': ['bravo', 'charlie', 'delta', 'echo']
    }
    for (const [clock, order] of Object.entries(orders)) {
      const catalog = createCatalogOperations({
        cache: new MemoryCatalogCache(),
        client: createDatabase(sqlite.asD1Database()),
        clock: () => new Date(clock),
        observe: () => undefined
      })
      expect((await catalog.getPublishedListings()).map(item => item.slug)).toEqual(order)
      for (const [index, slug] of order.entries()) {
        const detail = await catalog.getListingBySlug(slug)
        expect(
          [detail?.previousWebsite?.slug ?? null, detail?.nextWebsite?.slug ?? null],
          `${clock} ${slug}`
        ).toEqual([order[index - 1] ?? null, order[index + 1] ?? null])
      }
    }
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
    expect([...cache.values.keys()]).toContain('catalog-shell:v8:1.2027-01-01T00:00:00.000Z')
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

  it('searches name, short description, and active categories, never content or website', async () => {
    const catalog = operations().operations
    const slugs = async (query: string) =>
      (await catalog.searchListings(query, 20)).map(item => item.slug)

    expect(await slugs('charlie')).toEqual(['charlie'])
    expect(await slugs('  ALPHA \t  Listing ')).toEqual(['alpha'])
    expect(await slugs('bravo description')).toEqual(['bravo'])
    // Category slug or name: alpha, charlie, and echo are also in `secondary`.
    expect(await slugs('secondary')).toEqual(['alpha', 'charlie', 'echo'])
    expect(await slugs('listing primary category')).toEqual([
      'alpha',
      'bravo',
      'charlie',
      'delta',
      'echo'
    ])
    // A name match ranks first: exact, then prefix, then anywhere in the name.
    expect(await slugs('delta listing')).toEqual(['delta'])
    expect((await slugs('listing')).slice(0, 2)).toEqual(['alpha', 'bravo'])
    // The slug matches (owner decision, #81), the website URL never does (#81 round 2)...
    expect(await slugs('charlie')).toEqual(['charlie'])
    expect(await slugs('example.com')).toEqual([])
    expect(await slugs('https')).toEqual([])
    // ...and neither does the long content (owner decision, #77).
    expect(await slugs('detail content')).toEqual([])
    expect(await slugs('100%_off')).toEqual([])
  })

  it('answers long, many-word, CJK, and empty queries with four bindings and no LIKE', async () => {
    const catalog = operations().operations
    const start = sqlite.statements.length
    for (const query of [
      'a'.repeat(1000),
      Array.from({ length: 200 }, (_, index) => `word${index}`).join(' '),
      'the best free online video downloader for youtube and more',
      '视频下载器'.repeat(30),
      '🎬'.repeat(120),
      "'; DROP TABLE listings; --",
      '%%%___\\\\'
    ]) {
      expect(await catalog.searchListings(query, 50), query.slice(0, 20)).toEqual([])
    }
    expect(await catalog.searchListings('   \n\t ')).toEqual([])
    expect(await catalog.searchListings('')).toEqual([])

    const searches = sqlite.statements
      .slice(start)
      .filter(statement => statement.sql.includes("json_extract(?1, '$[0]')"))
    expect(searches).toHaveLength(7)
    for (const statement of searches) {
      expect(statement.sql).not.toMatch(/\b(?:LIKE|GLOB)\b/iu)
      expect(statement.bindings).toHaveLength(4)
      const terms = JSON.parse(String(statement.bindings[0])) as string[]
      expect(terms.length).toBeGreaterThan(0)
      expect(terms.length).toBeLessThanOrEqual(8)
      expect(Array.from(String(statement.bindings[2])).length).toBeLessThanOrEqual(100)
      expect(statement.bindings[3]).toBe(50)
    }
  })

  it('normalizes and caps search input instead of rejecting it', () => {
    // Only ASCII letters fold, exactly like SQLite's lower(); everything else matches as typed.
    expect(normalizeSearchQuery('  Ｆｕｌｌ\u0000Width   QUERY OÜ ')).toEqual({
      phrase: 'Ｆｕｌｌ width query oÜ',
      terms: ['Ｆｕｌｌ', 'width', 'query', 'oÜ']
    })
    const capped = normalizeSearchQuery(`${'🎬'.repeat(99)}xyz`)
    expect(Array.from(capped.phrase)).toHaveLength(100)
    expect(capped.phrase.endsWith('🎬x')).toBe(true)
    expect(normalizeSearchQuery('a b c d e f g h i j a b').terms).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
      'f',
      'g',
      'h'
    ])
    expect(normalizeSearchQuery(' \n ')).toEqual({ phrase: '', terms: [] })
  })

  it('caches search results per epoch and clamps the limit', async () => {
    const cache = new MemoryCatalogCache()
    const searchQueries = (events: Array<CatalogCacheEvent | CatalogQueryEvent>) =>
      events.filter(event => event.event === 'd1_query' && event.queryShape === 'search-summaries')

    const cold = operations(cache)
    const results = await cold.operations.searchListings('Listing', 5000)
    expect(results).toHaveLength(5)
    expect(searchQueries(cold.events)).toHaveLength(1)
    const limitBinding = sqlite.statements
      .filter(statement => statement.sql.includes("json_extract(?1, '$[0]')"))
      .at(-1)?.bindings[3]
    expect(limitBinding).toBe(MAX_SEARCH_LIMIT)

    const warm = operations(cache)
    expect(await warm.operations.searchListings('  listing  ', 5000)).toEqual(results)
    expect(searchQueries(warm.events)).toHaveLength(0)
    expect(warm.events).toContainEqual({
      event: 'catalog_cache',
      operation: 'search-summaries',
      state: 'hit'
    })

    sqlite.database.prepare('UPDATE publication_state SET version = 2').run()
    const nextEpoch = operations(cache)
    await nextEpoch.operations.searchListings('listing', 5000)
    expect(searchQueries(nextEpoch.events)).toHaveLength(1)
  })

  it('reuses an epoch the Worker entry shared instead of reading it again', async () => {
    const events: Array<CatalogCacheEvent | CatalogQueryEvent> = []
    const catalog = createCatalogOperations({
      cache: new MemoryCatalogCache(),
      client: createDatabase(sqlite.asD1Database()),
      clock: now,
      observe: event => events.push(event),
      reuseEpoch: () => ({ effectiveAt: '2026-07-05T00:00:00.000Z', version: 7 })
    })
    expect(await catalog.getPublicationVersion()).toBe(7)
    await catalog.getShellStats()
    expect(
      events.some(event => event.event === 'd1_query' && event.operation === 'publication-version')
    ).toBe(false)
  })

  it('logs a D1 error code, not the message, when a query fails', async () => {
    const events: Array<CatalogCacheEvent | CatalogQueryEvent> = []
    const failing = {
      prepare() {
        throw new Error(
          "D1_ERROR: too many SQL variables at offset 6536: SQLITE_ERROR params: ['secret search terms']"
        )
      }
    } as unknown as D1Database
    const catalog = createCatalogOperations({
      cache: new MemoryCatalogCache(),
      client: createDatabase(failing),
      clock: now,
      observe: event => events.push(event),
      reuseEpoch: () => ({ effectiveAt: null, version: 1 })
    })
    await expect(catalog.searchListings('anything')).rejects.toThrow()
    const failure = events.find(event => event.event === 'd1_query')
    expect(failure).toMatchObject({
      errorCode: 'SQLITE_ERROR:too_many_variables',
      operation: 'search-summaries',
      success: false
    })
    expect(JSON.stringify(failure)).not.toContain('secret')
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
      `catalog-shell:v8:${epoch(1)}`,
      `catalog-shell:v8:${epoch(2)}`
    ])
  })

  it('falls back to live D1 when cached shell data is corrupt or unavailable', async () => {
    const corrupt = new MemoryCatalogCache()
    corrupt.values.set(`catalog-shell:v8:${epoch(1)}`, { featuredCount: 'wrong' })
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
    corrupt.values.set(`catalog-published:v8:${epoch(2)}`, { items: 'wrong' })
    corrupt.values.set(`catalog-detail:v8:${epoch(2)}:charlie`, { detail: 'wrong' })
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

  it('derives a value once per epoch and format, reading no D1 rows for it (#334)', async () => {
    const cache = new MemoryCatalogCache()
    let computed = 0
    const derivation = (format = 'f1') => ({
      compute: () => {
        computed += 1
        return { body: `tree ${computed}` }
      },
      format,
      id: 'charlie',
      kind: 'listing-content' as const,
      validate: (value: unknown): value is { body: string } =>
        typeof (value as { body?: unknown } | null)?.body === 'string'
    })

    const cold = operations(cache)
    expect(await cold.operations.getDerivedValue(derivation())).toEqual({ body: 'tree 1' })
    // Only the epoch is read from D1; the value comes from `compute`.
    expect(
      cold.events.filter(event => event.event === 'd1_query').map(event => event.queryShape)
    ).toEqual(['publication-version'])
    expect(cache.values.get(`catalog-listing-content:v8:${epoch(1)}:f1:charlie`)).toEqual({
      publicationVersion: 1,
      value: { body: 'tree 1' }
    })
    expect(cache.ttlSeconds.get(`catalog-listing-content:v8:${epoch(1)}:f1:charlie`)).toBe(86400)

    const warm = operations(cache)
    expect(await warm.operations.getDerivedValue(derivation())).toEqual({ body: 'tree 1' })
    expect(warm.events).toContainEqual({
      event: 'catalog_cache',
      operation: 'listing-content',
      state: 'hit'
    })
    expect(computed).toBe(1)

    // Another format, a new epoch, or a corrupt entry derives it again.
    expect(await operations(cache).operations.getDerivedValue(derivation('f2'))).toEqual({
      body: 'tree 2'
    })
    sqlite.database.prepare('UPDATE publication_state SET version = 2 WHERE id = 1').run()
    expect(await operations(cache).operations.getDerivedValue(derivation())).toEqual({
      body: 'tree 3'
    })
    cache.values.set(`catalog-listing-content:v8:${epoch(2)}:f1:charlie`, {
      publicationVersion: 2,
      value: { body: 7 }
    })
    const corrupt = operations(cache)
    expect(await corrupt.operations.getDerivedValue(derivation())).toEqual({ body: 'tree 4' })
    expect(corrupt.events).toContainEqual({
      event: 'catalog_cache',
      operation: 'listing-content',
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
      categoryName: 'primary category',
      name: 'echo listing',
      slug: 'echo'
    })
    for (const slug of ['charlie', 'future', 'missing']) {
      expect(await catalog.getUnpublishedListing(slug), slug).toBeNull()
    }
    expect((await catalog.getPublishedListings()).map(item => item.slug)).not.toContain('echo')
    expect(await catalog.searchListings('echo')).toEqual([])
  })

  it('answers 404, not 410, for an unpublished listing filed under a retired category (#260)', async () => {
    const sqlite = seeded()
    const client = createDatabase(sqlite.asD1Database())
    const gone = (slug: string) => isUnpublishedListingSlug({ client, slug })
    expect(await gone('echo')).toBe(true)
    // A secondary membership is enough, as for the adult downloaders filed under another
    // category; while the category is active, echo is still gone (410).
    sqlite.database.exec(`
      INSERT INTO categories (slug, name, description, sort_order) VALUES ('adult', 'Adult', '', 9);
      INSERT INTO listing_categories (listing_id, category_id, sort_order, is_primary)
        SELECT 'serp-echo', id, 5, 0 FROM categories WHERE slug = 'adult';
    `)
    expect(await gone('echo')).toBe(true)
    sqlite.database.exec("UPDATE categories SET is_active = 0 WHERE slug = 'adult'")
    expect(await gone('echo')).toBe(false)
    expect(await catalogFor(sqlite).getUnpublishedListing('echo')).toBeNull()
    // Live and unknown slugs are never gone.
    for (const slug of ['charlie', 'missing']) expect(await gone(slug), slug).toBe(false)
  })
})

describe('catalog epoch tokens shared by the Worker entry', () => {
  it('round-trips a token and refuses anything else', () => {
    for (const epoch of [
      { effectiveAt: '2026-07-05T00:00:00.000Z', version: 3 },
      { effectiveAt: null, version: 0 }
    ]) {
      expect(parseCatalogEpochToken(catalogEpochToken(epoch))).toEqual(epoch)
    }
    for (const token of ['', 'none', '.2026', 'x.2026-07-05', '1.', '-1.none', '1e3.none']) {
      expect(parseCatalogEpochToken(token), token).toBeNull()
    }
  })

  it('serves a shared epoch only while it is fresh', () => {
    shareCatalogEpochToken('5.2026-07-05T00:00:00.000Z', 1_000)
    expect(sharedCatalogEpoch(1_000 + 29_999)).toEqual({
      effectiveAt: '2026-07-05T00:00:00.000Z',
      version: 5
    })
    expect(sharedCatalogEpoch(1_000 + 30_000)).toBeNull()
    expect(sharedCatalogEpoch(999)).toBeNull()
    shareCatalogEpochToken('not a token', 2_000)
    expect(sharedCatalogEpoch(2_000)).toEqual({
      effectiveAt: '2026-07-05T00:00:00.000Z',
      version: 5
    })
  })
})

describe('legacy root-level URLs (#168)', () => {
  function seeded() {
    const sqlite = new SqliteD1()
    seedContractFixture(sqlite)
    sqlite.database.exec(`
      UPDATE listings SET is_active = 0 WHERE slug = 'echo';
      INSERT INTO categories(slug, name, description, sort_order, is_active)
        VALUES ('alpha', 'Shadowed', '', 9, 1), ('retired', 'Retired', '', 9, 0);
    `)
    const client = createDatabase(sqlite.asD1Database())
    const target = (slug: string) => legacyRootTarget({ asOf: now().toISOString(), client, slug })
    return { sqlite, target }
  }

  it('finds a public listing first, then an active category, else nothing', async () => {
    const { target } = seeded()
    expect(await target('bravo')).toEqual({ kind: 'listing', slug: 'bravo' })
    // A listing and a category with one slug: the listing wins, as on the old site.
    expect(await target('alpha')).toEqual({ kind: 'listing', slug: 'alpha' })
    expect(await target('primary')).toEqual({ kind: 'category', slug: 'primary' })
    // Unpublished, scheduled, inactive, or unknown: Next.js answers as before.
    for (const slug of ['echo', 'future', 'retired', 'missing']) {
      expect(await target(slug), slug).toBeNull()
    }
  })

  it('follows a retired listing slug to its public listing in one hop (#356)', async () => {
    const { sqlite, target } = seeded()
    // #338's case: an unpublished duplicate whose slug redirects to the listing it duplicated,
    // which has since been renamed (its id is followed, not `new_slug`).
    sqlite.database.exec(`
      INSERT INTO listing_slug_redirects (listing_id, old_slug, new_slug, manifest_id, reason)
        VALUES ('serp-charlie', 'echo', 'charlie', 'fixture', 'duplicate'),
               ('serp-echo', 'old-echo', 'echo', 'fixture', 'rename'),
               ('serp-future', 'old-future', 'future', 'fixture', 'rename');
      UPDATE listings SET slug = 'charlie-renamed' WHERE id = 'serp-charlie';
    `)
    expect(await target('echo')).toEqual({ kind: 'listing', slug: 'charlie-renamed' })
    expect(await target('old-bravo')).toEqual({ kind: 'listing', slug: 'bravo' })
    // The listing it points at must be public: unpublished or scheduled answers as before.
    expect(await target('old-echo')).toBeNull()
    expect(await target('old-future')).toBeNull()
    // A live listing or category with the slug still comes first.
    sqlite.database.exec(`
      INSERT INTO listing_slug_redirects (listing_id, old_slug, new_slug, manifest_id, reason)
        VALUES ('serp-charlie', 'bravo', 'charlie', 'fixture', 'rename'),
               ('serp-charlie', 'primary', 'charlie', 'fixture', 'rename');
    `)
    expect(await target('bravo')).toEqual({ kind: 'listing', slug: 'bravo' })
    expect(await target('primary')).toEqual({ kind: 'category', slug: 'primary' })
  })

  it('follows a retired category URL to its active target (#341)', async () => {
    const { sqlite, target } = seeded()
    seedTaxonomyFixture(sqlite)
    expect(await target('old-hub')).toEqual({
      kind: 'moved',
      target: { kind: 'category', slug: 'secondary' }
    })
    expect(await target('old-tag')).toEqual({
      kind: 'moved',
      target: { kind: 'tag', slug: 'writers' }
    })
    expect(await target('old-best')).toEqual({
      kind: 'moved',
      target: { kind: 'best', slug: 'best-writers' }
    })
    expect(await target('old-other')).toEqual({
      kind: 'moved',
      target: { kind: 'directory', slug: null }
    })
    // Only category sources were root-level URLs, a retired target answers 404, and an active
    // category with a redirect row still renders.
    for (const slug of ['old-writers', 'old-retired-tag']) {
      expect(await target(slug), slug).toBeNull()
    }
    expect(await target('primary')).toEqual({ kind: 'category', slug: 'primary' })
  })
})

describe('when a public listing last changed (#218)', () => {
  it('is the later of updated_at and published_at, in either D1 time format', async () => {
    const sqlite = new SqliteD1()
    seedContractFixture(sqlite)
    sqlite.database.exec(`
      UPDATE listings SET updated_at = '2026-07-20 10:30:00' WHERE slug = 'bravo';
      UPDATE listings SET updated_at = '2026-01-01T00:00:00.000Z' WHERE slug = 'charlie';
    `)
    const catalog = createCatalogOperations({
      cache: new MemoryCatalogCache(),
      client: createDatabase(sqlite.asD1Database()),
      clock: now,
      observe: () => {}
    })
    const bySlug = new Map((await catalog.getPublishedListings()).map(item => [item.slug, item]))
    // A `CURRENT_TIMESTAMP`-format edit after publication moves it.
    expect(bySlug.get('bravo')?.modifiedAt).toBe('2026-07-20T10:30:00.000Z')
    // An `updated_at` before publication (a scheduled listing) does not.
    const charlie = bySlug.get('charlie')
    expect(charlie?.modifiedAt).toBe(
      new Date(
        sqlite.database.prepare("SELECT published_at FROM listings WHERE slug = 'charlie'").get()
          ?.published_at as string
      ).toISOString()
    )
    expect((await catalog.getListingBySlug('bravo'))?.modifiedAt).toBe('2026-07-20T10:30:00.000Z')
    // A directory page carries its collection's newest change.
    const page = await catalog.getListingNamePage({ page: 1, pageSize: 2 })
    expect(page.lastModifiedAt).toBe(
      [...bySlug.values()]
        .map(item => item.modifiedAt)
        .sort()
        .at(-1)
    )
  })
})

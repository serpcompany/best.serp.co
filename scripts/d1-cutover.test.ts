import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { buildPublicationPlan, executePublicationPlan, manifestSchema } from './d1-publisher.ts'

const provenance = {
  actor: 'publisher@example.com',
  workflow: 'local/manual',
  beforeChecksum: 'a'.repeat(64)
}

describe('local D1 cutover contracts', () => {
  it('keeps the reviewed SQL bootstrap and parity evidence internally consistent', () => {
    const artifactSql = readFileSync(resolve('d1/artifacts/serp-software-v1.sql'), 'utf8')
    const reportSource = readFileSync(resolve('d1/artifacts/serp-software-v1-parity.yaml'), 'utf8')
    const report = parse(reportSource) as {
      parity: {
        duplicateSlugs: string[]
        exactSlugSet: string[]
        importBatches: number
        invalidRecords: unknown[]
        records: Array<{ checksum: string; source: unknown; target: unknown }>
      }
      source: { productCount: number }
      target: { listingCount: number }
    }
    expect(report.parity.duplicateSlugs).toEqual([])
    expect(report.parity.invalidRecords).toEqual([])
    expect(report.parity.exactSlugSet).toHaveLength(report.source.productCount)
    expect(report.target.listingCount).toBe(report.source.productCount)
    expect(report.parity.records).toHaveLength(report.source.productCount)
    expect(
      readdirSync(resolve('d1/artifacts/serp-software-v1-import')).filter(file =>
        file.endsWith('.sql')
      )
    ).toHaveLength(report.parity.importBatches)
    expect(artifactSql).toContain(report.target.checksum)
    expect(
      readFileSync(resolve('d1/artifacts/serp-software-v1-import/0001.sql'), 'utf8')
    ).toContain("'serp.software'")
    expect(
      report.parity.records.every(
        record => record.checksum && JSON.stringify(record.source) === JSON.stringify(record.target)
      )
    ).toBe(true)
  })

  it('normalizes repeatable fields and enforces public and tenant invariants', () => {
    const migration = readFileSync(resolve('d1/migrations/0001_public_catalog.sql'), 'utf8')
    const displayOrderMigration = readFileSync(
      resolve('d1/migrations/0004_listing_display_order.sql'),
      'utf8'
    )
    expect(migration).toContain('CREATE TABLE listing_categories')
    expect(migration).toContain('CREATE TABLE listing_media')
    expect(migration).toContain('CREATE TABLE listing_resource_links')
    expect(migration).toContain('CREATE TABLE listing_faqs')
    expect(migration).not.toContain('CREATE TABLE listing_slug_redirects')
    expect(
      readFileSync(resolve('d1/migrations/0002_listing_slug_redirects.sql'), 'utf8')
    ).toContain('CREATE TABLE listing_slug_redirects')
    expect(migration).toContain('listing_categories_same_site_insert')
    expect(migration).toContain('listings_require_primary_on_insert')
    expect(migration).toContain('listing_categories_prevent_primary_demote')
    expect(migration).not.toContain('CREATE VIRTUAL TABLE')
    expect(migration).not.toContain('listing_search')
    expect(migration).not.toMatch(/categories_json|media_json|resource_links_json/)
    expect(displayOrderMigration).toContain('display_order INTEGER NOT NULL DEFAULT 0')
    expect(displayOrderMigration).toContain('published_at DESC, display_order, slug')
  })

  it('publishes FAQs, preserves explicit listing identity, and audits slug redirects', () => {
    const listing = {
      id: 'lst_stable_identity',
      slug: 'renamed-product',
      name: 'Renamed Product',
      description: 'A complete description',
      website: 'https://example.com',
      publishedAt: '2026-07-13T00:00:00.000Z',
      categories: ['analytics', 'seo'],
      faqs: [{ question: 'Does it work?', answer: 'Yes.' }]
    }
    const manifest = manifestSchema.parse({
      version: 1,
      id: 'release-1',
      siteId: 'serp.software',
      basePublicationVersion: 4,
      provenance,
      operations: [
        { action: 'listing-update', listing, previousCategories: ['marketing'] },
        {
          action: 'listing-slug-change',
          id: 'lst_second_identity',
          from: 'old-slug',
          to: 'new-slug',
          categories: ['seo'],
          reason: 'Canonical product rename'
        }
      ]
    })
    const publication = buildPublicationPlan(
      manifest,
      'manifest source',
      '2026-07-13T01:00:00.000Z'
    )
    const queries = publication.statements.map(item => item.query).join('\n')
    const bindings = publication.statements.flatMap(item => item.bindings)

    expect(queries).toContain("id=? AND slug=? AND status='approved' AND is_active=1")
    expect(queries).toContain('INSERT INTO listing_faqs')
    expect(queries).toContain('INSERT INTO listing_slug_redirects')
    expect(queries).toContain('c.slug NOT IN (?)')
    expect(queries).not.toMatch(/BEGIN IMMEDIATE|COMMIT;/)
    expect(bindings).toEqual(
      expect.arrayContaining([
        'lst_stable_identity',
        'lst_second_identity',
        'old-slug',
        'new-slug',
        'release-1',
        'Canonical product rename'
      ])
    )
    expect(queries).not.toContain('Canonical product rename')
    expect(publication.affectedRoutes.split('\n')).toEqual(
      expect.arrayContaining([
        '/categories/analytics/',
        '/categories/marketing/',
        '/categories/seo/',
        '/products/old-slug/',
        '/products/new-slug/',
        '/products/renamed-product/'
      ])
    )
  })

  it('executes a validated publication plan as one D1 batch', async () => {
    const prepared: string[] = []
    const bound: unknown[][] = []
    let batches = 0
    const database = {
      prepare(query: string) {
        prepared.push(query)
        return {
          bind(...values: unknown[]) {
            bound.push(values)
            return this
          }
        }
      },
      async batch(statements: unknown[]) {
        batches += 1
        expect(statements).toHaveLength(2)
        return []
      }
    }
    await executePublicationPlan(database, {
      affectedRoutes: '/',
      afterChecksum: 'b'.repeat(64),
      inputChecksum: 'c'.repeat(64),
      manifest: manifestSchema.parse({
        version: 1,
        id: 'execution-test',
        siteId: 'serp.software',
        basePublicationVersion: 0,
        provenance,
        operations: [{ action: 'category-unpublish', slug: 'seo' }]
      }),
      statements: [
        { query: 'SELECT ?', bindings: [1] },
        { query: 'SELECT ?', bindings: [2] }
      ]
    })
    expect(batches).toBe(1)
    expect(prepared).toEqual(['SELECT ?', 'SELECT ?'])
    expect(bound).toEqual([[1], [2]])
  })

  it('resolves old product slugs through the stable listing ID before notFound', () => {
    const repository = readFileSync(resolve('apps/serp.software/lib/catalog/repository.ts'), 'utf8')
    const dataOperations = readFileSync(resolve('packages/data-ops/src/catalog.ts'), 'utf8')
    const route = readFileSync(resolve('apps/serp.software/app/products/[slug]/page.tsx'), 'utf8')
    expect(repository).toContain("from '@serpdirectory/data-ops/catalog'")
    expect(repository).not.toMatch(/\b(?:SELECT|WITH)\b/u)
    expect(dataOperations).toContain(
      '.innerJoin(listings, eq(listings.id, listingSlugRedirects.listingId))'
    )
    expect(dataOperations).toContain('eq(listingSlugRedirects.oldSlug, oldSlug)')
    expect(dataOperations).toMatch(/sql`\$\{listings\.publishedAt\} <= \$\{asOf\}`/u)
    expect(route.indexOf('permanentRedirect')).toBeLessThan(
      route.indexOf('notFound()', route.indexOf('if (!project)'))
    )
  })

  it('rejects unknown manifest and nested fields', () => {
    const result = manifestSchema.safeParse({
      version: 1,
      id: 'strict-release',
      siteId: 'serp.software',
      basePublicationVersion: 0,
      provenance,
      typo: true,
      operations: [
        {
          action: 'listing-unpublish',
          id: 'lst_strict_test',
          slug: 'strict-test',
          categories: ['seo'],
          unexpected: true
        }
      ]
    })
    expect(result.success).toBe(false)
    if (!result.success)
      expect(result.error.issues.filter(issue => issue.code === 'unrecognized_keys')).toHaveLength(
        2
      )
  })

  it('rejects duplicate listing repeatables and manifest operation targets', () => {
    const baseListing = {
      id: 'lst_duplicate_test',
      slug: 'duplicate-test',
      name: 'Duplicate Test',
      description: 'A complete description',
      website: 'https://example.com',
      publishedAt: '2026-07-13T00:00:00.000Z',
      categories: ['seo', 'seo'],
      images: undefined,
      media: { images: ['same.png', 'same.png'] },
      resources: [
        { label: 'Docs', url: 'https://example.com/docs' },
        { label: 'Docs', url: 'https://example.com/docs' }
      ],
      faqs: [
        { question: 'Same?', answer: 'One' },
        { question: 'Same?', answer: 'Two' }
      ]
    }
    const result = manifestSchema.safeParse({
      version: 1,
      id: 'duplicate-release',
      siteId: 'serp.software',
      basePublicationVersion: 0,
      provenance,
      operations: [
        { action: 'listing-create', listing: baseListing },
        {
          action: 'listing-unpublish',
          id: 'lst_duplicate_test',
          slug: 'another-slug',
          categories: ['seo']
        }
      ]
    })

    expect(result.success).toBe(false)
    if (!result.success)
      expect(result.error.issues.map(issue => issue.message)).toEqual(
        expect.arrayContaining([
          'Duplicate listing category.',
          'Duplicate listing image.',
          'Duplicate listing resource.',
          'Duplicate listing FAQ.',
          'Duplicate listing operation ID.'
        ])
      )
  })

  it('pins every executable D1 path to the dedicated local identity', () => {
    const config = JSON.parse(
      readFileSync(resolve('configs/wrangler/serp.software/local.jsonc'), 'utf8')
    ) as {
      name: string
      vars: { D1_RUNTIME_ENV: string }
      d1_databases: Array<{
        database_id: string
        database_name: string
        migrations_dir: string
      }>
    }
    expect(config.name).toBe('serp-software-local')
    expect(config.vars.D1_RUNTIME_ENV).toBe('local')
    expect(config.d1_databases[0]).toEqual(
      expect.objectContaining({
        database_id: '00000000-0000-0000-0000-000000000068',
        database_name: 'serp-software-local',
        migrations_dir: '../../../d1/drizzle'
      })
    )
    const guard = readFileSync(resolve('scripts/d1-local-guard.ts'), 'utf8')
    const publisher = readFileSync(resolve('scripts/d1-publisher.ts'), 'utf8')
    expect(guard).toContain("'--local'")
    expect(guard).toContain('configuredFreshD1StateRoot(target.siteId)')
    expect(guard).toContain('validateCanonicalLocalConfig(target)')
    expect(guard).toContain('resolveSiteTarget(siteValue)')
    expect(publisher).toContain('CLI publication is disabled')
    expect(publisher).toContain('D1Database.batch')
    expect(`${guard}\n${publisher}`).not.toMatch(
      /--remote|preview_database_id|production_database_id/i
    )
  })

  it('accepts every isolated Worker runtime and binds redirect eligibility by tenant', () => {
    const repositories = [
      'apps/serp.software/lib/catalog/repository.ts',
      'apps/pornvideodownloaders.com/lib/catalog/repository.ts'
    ].map(file => readFileSync(resolve(file), 'utf8'))
    const dataOperations = readFileSync(resolve('packages/data-ops/src/catalog.ts'), 'utf8')
    const environmentTypes = readFileSync(resolve('apps/serp.software/cloudflare-env.d.ts'), 'utf8')
    for (const repository of repositories) {
      expect(repository).toContain("new Set(['local', 'preview', 'production'])")
      expect(repository).toContain("from '@serpdirectory/data-ops/catalog'")
      expect(repository).toContain('resolveRuntimeSiteId')
      expect(repository).not.toMatch(/\b(?:SELECT|WITH)\b/u)
    }
    expect(environmentTypes).toContain("'local' | 'preview' | 'production'")
    expect(dataOperations).toContain('eq(listingSlugRedirects.siteId, siteId)')
    expect(dataOperations).toContain('normalized.split(/\\s+/u)')
    expect(dataOperations).toContain('lower(l.website) LIKE ?')
    expect(dataOperations).toContain('l.display_order ASC')
  })

  it('keeps production exports compatible by avoiding virtual tables', () => {
    const migration = readFileSync(resolve('d1/migrations/0001_public_catalog.sql'), 'utf8')
    const release = readFileSync(resolve('scripts/worker-release.ts'), 'utf8')
    expect(release).toMatch(/'d1',\s*'export'/u)
    expect(migration).not.toMatch(/CREATE\\s+VIRTUAL\\s+TABLE/i)
  })
})

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createDatabase } from './client'
import type { CatalogQueryEvent } from './contracts'
import {
  fixtureCategoryIds,
  insertPublishedListing,
  MemoryCatalogCache,
  SqliteD1,
  seedContractFixture
} from './test-support'

vi.mock('server-only', () => ({}))

const { createCatalogOperations } = await import('./catalog')

interface ScanEvidence {
  plan: string[]
  rows: number | null
}

const benchmarkNow = () => new Date('2026-07-30T00:00:00.000Z')
const scanStatsAvailable =
  process.env.DATA_OPS_FORCE_SCANSTATS_UNAVAILABLE !== '1' &&
  !spawnSync('sqlite3', ['-cmd', '.scanstats on', ':memory:', 'SELECT 1'], {
    encoding: 'utf8'
  }).stderr.includes('not available')

function sqlLiteral(value: unknown): string {
  if (value === null) return 'NULL'
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'string') return `'${value.replaceAll("'", "''")}'`
  throw new Error(`Unsupported benchmark SQL binding: ${typeof value}`)
}

function bindSql(sql: string, bindings: unknown[]): string {
  let index = 0
  const bound = sql.replaceAll('?', () => {
    const value = bindings[index]
    index += 1
    return sqlLiteral(value)
  })
  if (index !== bindings.length)
    throw new Error(`Benchmark bound ${index} placeholders for ${bindings.length} values.`)
  return bound
}

function scanRows(line: string): number | null {
  const labelled = /\brows=(\d+)\b/u.exec(line)
  if (labelled?.[1]) return Number(labelled[1])
  const columns = /\s+(\d+)\s+(\d+)\s*$/u.exec(line)
  return columns?.[2] ? Number(columns[2]) : null
}

function scan(databasePath: string, sql: string): ScanEvidence {
  const output = execFileSync(
    'sqlite3',
    [
      ...(scanStatsAvailable ? ['-cmd', '.scanstats on'] : []),
      '-cmd',
      '.eqp on',
      databasePath,
      sql
    ],
    { encoding: 'utf8' }
  )
  const rows = scanStatsAvailable
    ? output
        .split('\n')
        .filter(
          line =>
            /\b(?:SEARCH|SCAN)\b/u.test(line) &&
            !line.includes('candidate_ids') &&
            !line.includes('CONSTANT ROWS')
        )
        .map(scanRows)
        .filter((rows): rows is number => rows !== null)
        .reduce((total, rows) => total + rows, 0)
    : null
  return {
    plan: output
      .split('\n')
      .filter(line => /SEARCH|SCAN|USE TEMP B-TREE/u.test(line))
      .map(line => line.trim()),
    rows
  }
}

function totalRows(evidence: ScanEvidence[]): number | null {
  if (evidence.some(item => item.rows === null)) return null
  return evidence.reduce((total, item) => total + (item.rows || 0), 0)
}

function addBenchmarkRows(sqlite: SqliteD1): void {
  const { database } = sqlite
  const categories = fixtureCategoryIds(database)
  const primary = categories.get('primary')
  const secondary = categories.get('secondary')
  if (!primary || !secondary) throw new Error('Missing benchmark categories.')

  for (let index = 0; index < 315; index += 1) {
    const sequence = String(index).padStart(3, '0')
    const id = `serp-bench-${sequence}`
    const slug = `bench-${sequence}`
    const day = String(1 + Math.floor(index / 28)).padStart(2, '0')
    insertPublishedListing(database, {
      categoryIds: index % 2 === 0 ? [primary, secondary] : [primary],
      content: `Benchmark detail ${sequence}`,
      description: `Benchmark description ${sequence}`,
      displayOrder: index % 4,
      id,
      isFeatured: index < 6,
      name: `Benchmark ${sequence}`,
      publishedAt: `2026-06-${day}T00:00:00.000Z`,
      slug,
      website: `https://${slug}.example.com`
    })
    database
      .prepare(
        "INSERT INTO listing_media(listing_id, kind, url, sort_order) VALUES (?, 'logo', ?, 0)"
      )
      .run(id, `https://assets.example/${id}-logo.png`)
    for (let resource = 0; resource < 6; resource += 1) {
      database
        .prepare(
          'INSERT INTO listing_resource_links(listing_id, label, url, sort_order) VALUES (?, ?, ?, ?)'
        )
        .run(id, `Resource ${resource}`, `https://resources.example/${id}/${resource}`, resource)
    }
    for (let faq = 0; faq < 5; faq += 1) {
      database
        .prepare(
          'INSERT INTO listing_faqs(listing_id, question, answer, sort_order) VALUES (?, ?, ?, ?)'
        )
        .run(id, `Question ${faq}`, `Answer ${faq}`, faq)
    }
  }
}

describe('representative D1 query benchmark', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'data-ops-benchmark-'))
  const databasePath = join(tempRoot, 'fixture.sqlite')
  let sqlite: SqliteD1

  beforeAll(() => {
    sqlite = new SqliteD1(databasePath)
    sqlite.database.exec('BEGIN')
    seedContractFixture(sqlite)
    addBenchmarkRows(sqlite)
    sqlite.database.exec('COMMIT')
    sqlite.database.exec('ANALYZE')
  })

  afterAll(() => {
    sqlite.database.close()
    rmSync(tempRoot, { force: true, recursive: true })
  })

  it('records bounded optimized scans and statement counts against legacy hotspots', async () => {
    const events: CatalogQueryEvent[] = []
    const catalog = createCatalogOperations({
      cache: new MemoryCatalogCache(),
      client: createDatabase(sqlite.asD1Database()),
      clock: benchmarkNow,
      observe: event => {
        if (event.event === 'd1_query') events.push(event)
      }
    })
    const currentId = 'serp-bench-160'
    const currentSlug = 'bench-160'
    const statementStart = sqlite.statements.length
    const detail = await catalog.getListingBySlug(currentSlug)
    const detailStatements = sqlite.statements.slice(statementStart)
    expect(detail?.slug).toBe(currentSlug)

    const optimizedPrevious = detailStatements.find(statement =>
      statement.sql.includes('l.slug < ?')
    )
    const optimizedNext = detailStatements.find(statement => statement.sql.includes('l.slug > ?'))
    const optimizedRelatedIndex = detailStatements.findIndex(statement =>
      statement.sql.includes('FROM listing_categories shared')
    )
    const firstNavigationIndex = detailStatements.findIndex(
      statement => statement.sql.includes('l.slug < ?') || statement.sql.includes('l.slug > ?')
    )
    if (
      !optimizedPrevious ||
      !optimizedNext ||
      optimizedRelatedIndex < 0 ||
      firstNavigationIndex < 0
    )
      throw new Error('Missing optimized benchmark statements.')
    const optimizedRelatedStatements = detailStatements.slice(
      optimizedRelatedIndex,
      firstNavigationIndex
    )

    const legacyAdjacent = scan(
      databasePath,
      `WITH ordered AS (
        SELECT id, slug,
          LAG(id) OVER (ORDER BY published_at DESC, display_order ASC, slug ASC) AS previous_id,
          LEAD(id) OVER (ORDER BY published_at DESC, display_order ASC, slug ASC) AS next_id
        FROM listings l
        WHERE l.status = 'approved' AND l.is_active = 1
          AND l.published_at IS NOT NULL
          AND datetime(l.published_at) <= datetime('2026-07-30T00:00:00.000Z')
      )
      SELECT previous_id, next_id FROM ordered WHERE slug = '${currentSlug}'`
    )
    const optimizedAdjacent = [
      scan(databasePath, bindSql(optimizedPrevious.sql, optimizedPrevious.bindings)),
      scan(databasePath, bindSql(optimizedNext.sql, optimizedNext.bindings))
    ]
    const optimizedAdjacentRows = totalRows(optimizedAdjacent)

    const legacyRelated = scan(
      databasePath,
      `SELECT l.id
       FROM listings l
       JOIN listing_categories candidate ON candidate.listing_id = l.id
       JOIN listing_categories current
         ON current.category_id = candidate.category_id AND current.listing_id = '${currentId}'
       WHERE l.status = 'approved' AND l.is_active = 1
         AND l.published_at IS NOT NULL
         AND datetime(l.published_at) <= datetime('2026-07-30T00:00:00.000Z')
         AND l.id != '${currentId}'
       GROUP BY l.id
       ORDER BY COUNT(*) DESC, l.name
       LIMIT 4`
    )
    const optimizedRelatedEvidence = optimizedRelatedStatements.map(statement =>
      scan(databasePath, bindSql(statement.sql, statement.bindings))
    )
    const optimizedRelatedRows = totalRows(optimizedRelatedEvidence)
    const singleCategoryStart = sqlite.statements.length
    await catalog.getListingBySlug('bench-161')
    const singleCategoryStatements = sqlite.statements
      .slice(singleCategoryStart)
      .filter(
        statement =>
          statement.sql.includes('INDEXED BY listings_related_name_idx') ||
          statement.sql.includes('FROM listing_media')
      )
    const singleCategoryRows = totalRows(
      singleCategoryStatements.map(statement =>
        scan(databasePath, bindSql(statement.sql, statement.bindings))
      )
    )

    const shellStart = sqlite.statements.length
    await catalog.getShellStats()
    const coldShellStatements = sqlite.statements.slice(shellStart)
    const warmStart = sqlite.statements.length
    await catalog.getShellStats()
    const warmShellStatements = sqlite.statements.slice(warmStart)
    const coldShellRows = totalRows(
      coldShellStatements.map(statement =>
        scan(databasePath, bindSql(statement.sql, statement.bindings))
      )
    )
    const warmShellRows = totalRows(
      warmShellStatements.map(statement =>
        scan(databasePath, bindSql(statement.sql, statement.bindings))
      )
    )
    const oneColdPlus99WarmAverage =
      coldShellRows === null || warmShellRows === null
        ? null
        : (coldShellRows + warmShellRows * 99) / 100

    const report = {
      fixture: {
        categories: 3,
        eligibleListings: 320
      },
      navigation: {
        legacyScanRows: legacyAdjacent.rows,
        optimizedScanRows: optimizedAdjacentRows,
        statementCount: detailStatements.length
      },
      related: {
        legacyScanRows: legacyRelated.rows,
        optimizedPlan: [
          ...new Set(
            optimizedRelatedEvidence
              .flatMap(evidence => evidence.plan)
              .filter(line => !line.includes('loops='))
          )
        ],
        optimizedScanRows: optimizedRelatedRows,
        singleCategoryOptimizedScanRows: singleCategoryRows
      },
      shell: {
        coldScanRows: coldShellRows,
        warmScanRows: warmShellRows,
        oneColdPlus99WarmAverage
      },
      scanStatus: scanStatsAvailable ? 'available' : 'unavailable'
    }
    console.info(`DATA_OPS_BENCHMARK ${JSON.stringify(report)}`)

    expect(optimizedAdjacent.flatMap(evidence => evidence.plan).join('\n')).toContain(
      'listings_publication_idx'
    )
    const optimizedRelatedPlan = optimizedRelatedEvidence
      .flatMap(evidence => evidence.plan)
      .join('\n')
    expect(optimizedRelatedPlan).toContain('listings_related_name_idx')
    expect(optimizedRelatedPlan).not.toContain('USE TEMP B-TREE')
    if (scanStatsAvailable) {
      expect(legacyAdjacent.rows).not.toBeNull()
      expect(optimizedAdjacentRows).not.toBeNull()
      expect(legacyAdjacent.rows as number).toBeGreaterThan(optimizedAdjacentRows as number)
      expect(optimizedAdjacentRows as number).toBeLessThanOrEqual(100)
      expect(optimizedRelatedRows as number).toBeLessThanOrEqual(700)
      expect(singleCategoryRows as number).toBeLessThanOrEqual(100)
      expect(warmShellRows as number).toBeLessThanOrEqual(10)
      expect(oneColdPlus99WarmAverage as number).toBeLessThanOrEqual(25)
    } else {
      expect([
        legacyAdjacent.rows,
        optimizedAdjacentRows,
        optimizedRelatedRows,
        singleCategoryRows,
        coldShellRows,
        oneColdPlus99WarmAverage
      ]).toEqual(Array(6).fill(null))
      expect(warmShellRows).toBe(0)
    }
    expect(detailStatements.length).toBeLessThanOrEqual(10)
    expect(events.every(event => event.success)).toBe(true)
  })
})

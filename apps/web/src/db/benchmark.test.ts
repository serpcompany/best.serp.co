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

/** Inlines a statement's values: anonymous `?` in order, or numbered `?N` (#378's batch). */
function bindSql(sql: string, bindings: unknown[]): string {
  let index = 0
  const used = new Set<number>()
  const bound = sql.replaceAll(/\?(\d+)?/gu, (_, number: string | undefined) => {
    const position = number === undefined ? index++ : Number(number) - 1
    used.add(position)
    return sqlLiteral(bindings[position])
  })
  if (used.size !== bindings.length)
    throw new Error(`Benchmark bound ${used.size} placeholders for ${bindings.length} values.`)
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

/** Benchmark listings from this index on carry tags (#345); the ones before have none. */
const FIRST_TAGGED = 200
/** The one listing before them with a tag, which no other listing has. */
const SOLO_TAGGED = 120

function addBenchmarkRows(sqlite: SqliteD1): void {
  const { database } = sqlite
  const categories = fixtureCategoryIds(database)
  const primary = categories.get('primary')
  const secondary = categories.get('secondary')
  if (!primary || !secondary) throw new Error('Missing benchmark categories.')
  const insertTag = database.prepare(
    'INSERT INTO tags(slug, name, category_id) VALUES (?, ?, ?) RETURNING id'
  )
  const everyTagged = Number((insertTag.get('bench-all', 'All', primary) as { id: number }).id)
  const thirdTagged = Number(
    (insertTag.get('bench-third', 'Third', secondary) as { id: number }).id
  )
  // A tag only bench-120 has: its related listings all come from its hub (#362 review).
  const soloTagged = Number((insertTag.get('bench-solo', 'Solo', primary) as { id: number }).id)
  const insertMembership = database.prepare(
    'INSERT INTO listing_tags(listing_id, tag_id, sort_order) VALUES (?, ?, ?)'
  )

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
    if (index === SOLO_TAGGED) insertMembership.run(id, soloTagged, 0)
    if (index >= FIRST_TAGGED) {
      insertMembership.run(id, everyTagged, 0)
      if (index % 3 === 0) insertMembership.run(id, thirdTagged, 1)
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
    const cache = new MemoryCatalogCache()
    const operations = () =>
      createCatalogOperations({
        cache,
        client: createDatabase(sqlite.asD1Database()),
        clock: benchmarkNow,
        observe: event => {
          if (event.event === 'd1_query') events.push(event)
        }
      })
    const scanStatements = (statements: typeof sqlite.statements) =>
      statements.map(statement => scan(databasePath, bindSql(statement.sql, statement.bindings)))

    // Shell statistics: one cold aggregate, then an epoch probe plus a cache hit.
    const shellStart = sqlite.statements.length
    await operations().getShellStats()
    const coldShellStatements = sqlite.statements.slice(shellStart)
    const warmStart = sqlite.statements.length
    await operations().getShellStats()
    const warmShellStatements = sqlite.statements.slice(warmStart)
    const coldShellRows = totalRows(scanStatements(coldShellStatements))
    const warmShellRows = totalRows(scanStatements(warmShellStatements))
    const oneColdPlus99WarmAverage =
      coldShellRows === null || warmShellRows === null
        ? null
        : (coldShellRows + warmShellRows * 99) / 100
    // The previous shell query counted each category with a correlated subquery.
    const legacyShell = scan(
      databasePath,
      `SELECT c.slug, (
        SELECT COUNT(*) FROM listing_categories lc JOIN listings l ON l.id = lc.listing_id
        WHERE lc.category_id = c.id AND l.status = 'approved' AND l.is_active = 1
          AND l.published_at IS NOT NULL AND l.published_at <= '2026-07-30T00:00:00.000Z'
      ) FROM categories c WHERE c.is_active = 1`
    )

    // Detail of a listing in two categories, with no tag, hand pick or best page: its
    // alternatives come from its hub (`primary`, over 128 members) by walking the public name
    // index, batched with the detail row (#519 dropped the previous and next listings).
    const catalog = operations()
    const currentSlug = 'bench-160'
    const statementStart = sqlite.statements.length
    const detail = await catalog.getListingBySlug(currentSlug)
    const detailStatements = sqlite.statements.slice(statementStart)
    expect(detail?.slug).toBe(currentSlug)
    const optimizedAlternatives = detailStatements.find(statement =>
      statement.sql.includes('alternative.score')
    )
    if (!optimizedAlternatives) throw new Error('Missing alternatives benchmark statement.')
    const optimizedAlternativesEvidence = scanStatements([optimizedAlternatives])
    const optimizedAlternativesRows = totalRows(optimizedAlternativesEvidence)

    // Single-category detail in a dense category: the public name index seek, onward from its own
    // name (#331): the six names after it (#519), not the category's first six.
    const singleCategoryStart = sqlite.statements.length
    const single = await catalog.getListingBySlug('bench-161')
    const singleCategoryStatements = sqlite.statements
      .slice(singleCategoryStart)
      .filter(statement => statement.sql.includes('alternative.score'))
    const singleCategoryEvidence = scanStatements(singleCategoryStatements)
    const singleCategoryRows = totalRows(singleCategoryEvidence)
    const expectedSingleRelated = (
      sqlite.database
        .prepare(
          `SELECT l.slug FROM listings l
           JOIN listing_categories lc ON lc.listing_id = l.id
           WHERE lc.category_id = ? AND l.status = 'approved'
             AND l.published_at <= '2026-07-30T00:00:00.000Z'
             AND (l.name, l.slug) > (SELECT name, slug FROM listings WHERE slug = 'bench-161')
           ORDER BY l.name, l.slug LIMIT 6`
        )
        .all(fixtureCategoryIds(sqlite.database).get('primary') ?? -1) as Array<{ slug: string }>
    ).map(row => row.slug)

    // Tagged detail (#345): alternatives by shared tags. bench-250 has only the tag every tagged
    // listing has, so every candidate ties, and the keyset from its own name picks the next six
    // names; bench-313, near the end, wraps round to the first tagged names.
    const taggedStart = sqlite.statements.length
    const tagged = await operations().getListingBySlug('bench-250')
    const taggedStatements = sqlite.statements.slice(taggedStart)
    const taggedRelated = taggedStatements.find(statement =>
      statement.sql.includes('alternative.wrap')
    )
    if (!taggedRelated) throw new Error('Missing alternatives-by-tags benchmark statement.')
    const taggedEvidence = scanStatements([taggedRelated])
    const taggedRows = totalRows(taggedEvidence)
    const sharedTagMemberships = Number(
      (
        sqlite.database
          .prepare(
            `SELECT COUNT(*) AS total FROM listing_tags current
             JOIN listing_tags shared ON shared.tag_id = current.tag_id
             WHERE current.listing_id = ?`
          )
          .get('serp-bench-250') as { total: number }
      ).total
    )
    const wrapped = await catalog.getListingBySlug('bench-313')
    // A tag no other listing has: the hub (`primary`, over 128 members) fills all six by walking
    // the public name index from bench-120's own name, in the same statement.
    const soloStart = sqlite.statements.length
    const solo = await operations().getListingBySlug('bench-120')
    const soloStatements = sqlite.statements.slice(soloStart)
    const soloRelated = soloStatements.find(statement => statement.sql.includes('alternative.wrap'))
    if (!soloRelated) throw new Error('Missing hub-fill benchmark statement.')
    const soloEvidence = scanStatements([soloRelated])
    const soloRows = totalRows(soloEvidence)

    const report = {
      fixture: {
        categories: 3,
        eligibleListings: 320,
        taggedListings: 315 - FIRST_TAGGED
      },
      alternatives: {
        optimizedPlan: [
          ...new Set(
            optimizedAlternativesEvidence
              .flatMap(evidence => evidence.plan)
              .filter(line => !line.includes('loops='))
          )
        ],
        optimizedScanRows: optimizedAlternativesRows,
        singleCategoryOptimizedScanRows: singleCategoryRows,
        statementCount: detailStatements.length
      },
      relatedByTags: {
        optimizedPlan: [
          ...new Set(
            taggedEvidence
              .flatMap(evidence => evidence.plan)
              .filter(line => !line.includes('loops='))
          )
        ],
        hubFillScanRows: soloRows,
        hubFillStatementCount: soloStatements.length,
        optimizedScanRows: taggedRows,
        sharedMemberships: sharedTagMemberships,
        statementCount: taggedStatements.length
      },
      shell: {
        coldScanRows: coldShellRows,
        legacyScanRows: legacyShell.rows,
        warmScanRows: warmShellRows,
        oneColdPlus99WarmAverage
      },
      scanStatus: scanStatsAvailable ? 'available' : 'unavailable'
    }
    console.info(`DATA_OPS_BENCHMARK ${JSON.stringify(report)}`)

    expect(single?.relatedWebsites.map(related => related.slug)).toEqual(expectedSingleRelated)
    expect(optimizedAlternativesEvidence.flatMap(evidence => evidence.plan).join('\n')).toContain(
      'listings_related_name_idx'
    )
    expect(singleCategoryEvidence.flatMap(evidence => evidence.plan).join('\n')).toContain(
      'listings_related_name_idx'
    )
    expect(tagged?.relatedWebsites.map(related => related.slug)).toEqual([
      'bench-251',
      'bench-252',
      'bench-253',
      'bench-254',
      'bench-255',
      'bench-256'
    ])
    expect(wrapped?.relatedWebsites.map(related => related.slug)).toEqual([
      'bench-314',
      'bench-200',
      'bench-201',
      'bench-202',
      'bench-203',
      'bench-204'
    ])
    expect(taggedEvidence.flatMap(evidence => evidence.plan).join('\n')).toContain(
      'listing_tags_tag_idx'
    )
    expect(solo?.relatedWebsites.map(related => related.slug)).toEqual([
      'bench-121',
      'bench-122',
      'bench-123',
      'bench-124',
      'bench-125',
      'bench-126'
    ])
    expect(soloEvidence.flatMap(evidence => evidence.plan).join('\n')).toContain(
      'listings_related_name_idx'
    )
    if (scanStatsAvailable) {
      // The hub-size probe and the walk, as for the single-category seek below.
      expect(optimizedAlternativesRows as number).toBeLessThanOrEqual(2 * 129 + 100)
      // Each shared membership's index entry and its grouped row, then each candidate (here one
      // per membership, the worst case) read back, checked against the hub and read, and about 50
      // for the rest: 623 here (#519). Grouping first reads a listing that shares several tags
      // once, and the hub check skips the rows of those filed elsewhere.
      expect(taggedRows as number).toBeLessThanOrEqual(5 * sharedTagMemberships + 100)
      // The hub-size probe counts at most 129 public members, each a category index entry and its
      // listing row (#378 review: public members, as the shell statistics count them); the walk is
      // bounded like the single-category seek above.
      expect(soloRows as number).toBeLessThanOrEqual(2 * 129 + 100)
      // The same probe picks a single category's plan since #378 (it needs no shell statistics).
      expect(singleCategoryRows as number).toBeLessThanOrEqual(2 * 129 + 100)
      expect(legacyShell.rows as number).toBeGreaterThan(coldShellRows as number)
      expect(warmShellRows as number).toBeLessThanOrEqual(10)
      expect(oneColdPlus99WarmAverage as number).toBeLessThanOrEqual(25)
    } else {
      expect([
        optimizedAlternativesRows,
        singleCategoryRows,
        taggedRows,
        soloRows,
        coldShellRows,
        oneColdPlus99WarmAverage
      ]).toEqual(Array(6).fill(null))
    }
    // Epoch probe, detail row (with its hand picks), the rest of its alternatives.
    expect(detailStatements.length).toBeLessThanOrEqual(3)
    expect(taggedStatements.length).toBeLessThanOrEqual(3)
    expect(soloStatements.length).toBeLessThanOrEqual(3)
    expect(events.every(event => event.success)).toBe(true)
  })
})

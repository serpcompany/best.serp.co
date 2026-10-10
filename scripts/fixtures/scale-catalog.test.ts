import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { submissionStatuses } from '../../apps/web/src/db/schema'
import { assertD1StatementLimits } from '../../apps/web/src/db/sql-limits'
import { applyMigrations } from '../../apps/web/src/db/test-support'
import {
  AFFILIATE_HOST,
  CATCH_ALL_CATEGORY,
  generateScaleCatalog,
  isPublicListing,
  SCALE_CATALOG_SEED,
  scaleCatalogStatements
} from './scale-catalog'

/**
 * The synthetic scale catalog (#314) behind the rows-read budgets: at least the v1 import's size,
 * its shape, only reserved hosts, the same rows for the same seed, and rows a freshly migrated
 * database accepts with every constraint and trigger on.
 */
const catalog = generateScaleCatalog()
const asOf = '2026-10-06T12:00:00.000Z'

function loaded(): DatabaseSync {
  const database = new DatabaseSync(':memory:')
  database.exec('PRAGMA foreign_keys = ON')
  applyMigrations(database)
  for (const { params, sql } of scaleCatalogStatements(catalog)) {
    assertD1StatementLimits(sql, params)
    database.prepare(sql).run(...params)
  }
  return database
}

describe('the synthetic scale catalog (#314)', () => {
  it('is the same for the same seed, and another for another seed', () => {
    const statements = JSON.stringify(scaleCatalogStatements(catalog))
    expect(JSON.stringify(scaleCatalogStatements(generateScaleCatalog(SCALE_CATALOG_SEED)))).toBe(
      statements
    )
    expect(JSON.stringify(scaleCatalogStatements(generateScaleCatalog(1)))).not.toBe(statements)
  })

  it('loads into a migrated database, at the v1 size and shape', () => {
    const database = loaded()
    try {
      const count = (sql: string) => Number(database.prepare(sql).get()?.count)
      const live = `status='approved' AND is_active=1 AND published_at IS NOT NULL`
      expect(count(`SELECT COUNT(*) AS count FROM listings WHERE ${live}`)).toBe(3_422)
      expect(count('SELECT COUNT(*) AS count FROM categories WHERE is_active=1')).toBe(141)
      expect(count(`SELECT COUNT(*) AS count FROM listings WHERE NOT (${live})`)).toBeGreaterThan(
        300
      )
      // One catch-all holding most listings, two large categories, and a long tail.
      const sizes = (
        database
          .prepare(
            `SELECT c.slug, COUNT(*) AS size FROM listing_categories lc
             JOIN categories c ON c.id = lc.category_id JOIN listings l ON l.id = lc.listing_id
             WHERE l.${live.replaceAll(' AND ', ' AND l.')} GROUP BY c.slug ORDER BY size DESC`
          )
          .all() as Array<{ size: number; slug: string }>
      ).map(row => [row.slug, row.size] as const)
      expect(sizes.slice(0, 3)).toEqual([
        [CATCH_ALL_CATEGORY, 2_868],
        ['video-downloaders', 335],
        ['ai-writing-tools', 261]
      ])
      expect(sizes.filter(([, size]) => size <= 5).length).toBeGreaterThanOrEqual(130)
      expect(sizes.reduce((total, [, size]) => total + size, 0)).toBe(3_777)
      expect(
        count(
          `SELECT COUNT(*) AS count FROM (SELECT lc.listing_id FROM listing_categories lc
           JOIN listings l ON l.id = lc.listing_id WHERE l.${live.replaceAll(' AND ', ' AND l.')}
           GROUP BY lc.listing_id HAVING COUNT(*) > 1)`
        )
      ).toBe(319)
      expect(count('SELECT COUNT(DISTINCT listing_id) AS count FROM listing_faqs')).toBe(335)
      expect(count('SELECT COUNT(DISTINCT listing_id) AS count FROM listing_resource_links')).toBe(
        337
      )
      expect(
        count('SELECT COUNT(*) AS count FROM listing_media WHERE media_key IS NOT NULL')
      ).toBeGreaterThan(6_000)
      expect(count(`SELECT COUNT(*) AS count FROM listings WHERE is_featured=1 AND ${live}`)).toBe(
        335
      )
      expect(
        count(
          `SELECT COUNT(*) AS count FROM listings l JOIN listing_categories lc ON lc.listing_id = l.id
           JOIN categories c ON c.id = lc.category_id WHERE c.is_active = 0`
        )
      ).toBeGreaterThan(100)
      expect(count('SELECT COUNT(*) AS count FROM listing_slug_redirects')).toBeGreaterThan(0)
      expect(
        count('SELECT COUNT(*) AS count FROM listing_owners WHERE revoked_at IS NULL')
      ).toBeGreaterThan(20)
      expect(
        count('SELECT COUNT(*) AS count FROM listing_owners WHERE revoked_at IS NOT NULL')
      ).toBe(3)
      expect(
        (
          database
            .prepare('SELECT DISTINCT status FROM listing_submissions ORDER BY status')
            .all() as Array<{ status: string }>
        ).map(row => row.status)
      ).toEqual([...submissionStatuses].sort())
      expect(catalog.listings.filter(listing => isPublicListing(listing, asOf))).toHaveLength(3_422)
    } finally {
      database.close()
    }
  })

  it('names no real product, domain or person: every URL is on a reserved host', () => {
    const urls = [
      ...catalog.listings.map(listing => listing.website),
      ...catalog.media.map(item => item.url),
      ...catalog.resources.map(link => link.url),
      ...catalog.submissions.flatMap(item => [item.website, item.logoUrl])
    ]
    const hosts = new Set(urls.map(url => new URL(url).hostname))
    expect(
      [...hosts].filter(host => !/(?:^|\.)example\.(?:com|net|org)$|\.test$/u.test(host))
    ).toEqual([])
    expect(hosts.has(AFFILIATE_HOST)).toBe(true)
    expect(
      [...catalog.listings, ...catalog.submissions].filter(
        item => !/^[a-z0-9-]+(?:\.test)?$/u.test(item.slug)
      )
    ).toEqual([])
    expect(catalog.users.filter(user => !user.email.endsWith('@example.com'))).toEqual([])
  })
})

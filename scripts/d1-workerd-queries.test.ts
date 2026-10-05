import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createAuthOperations } from '@serpdirectory/data-ops/auth'
import { noCatalogDataCache } from '@serpdirectory/data-ops/cache'
import { createCatalogOperations, MAX_SEARCH_LIMIT } from '@serpdirectory/data-ops/catalog'
import { createDatabase } from '@serpdirectory/data-ops/client'
import type {
  CatalogCacheEvent,
  CatalogQueryEvent,
  CatalogQueryShape
} from '@serpdirectory/data-ops/contracts'
import { createEmailDeliveryLedger } from '@serpdirectory/data-ops/email-deliveries'
import { assertD1StatementLimits } from '@serpdirectory/data-ops/sql-limits'
import { createSubmissionOperations } from '@serpdirectory/data-ops/submissions'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { getPlatformProxy } from 'wrangler'
import { project } from './project'

vi.mock('server-only', () => ({}))

/**
 * Every catalog, search, account, email, and submission query against Wrangler-local D1
 * (workerd) with the full committed catalog import and worst-case inputs (#77). node:sqlite
 * applies none of D1's limits; workerd applies most of them, and each statement also passes
 * `assertD1StatementLimits` (which adds the 32-argument function limit workerd skips). The
 * hot catalog queries have a rows-read budget each, so a plan regression or a full scan fails
 * here instead of on the bill. The last test checks that every operation ran.
 */
const NOW = new Date('2026-10-06T12:00:00.000Z')

/**
 * Most rows one statement of each shape may read on the imported catalog (3,422 listings,
 * 3,777 memberships, 141 categories). Measured values are in the comments; the budgets leave
 * room for growth but not for a lost index or a full scan of a larger table.
 */
const ROWS_READ_BUDGET: Record<CatalogQueryShape, number> = {
  'canonical-redirect': 10,
  'category-summaries': 2_000,
  'featured-summaries': 2_500, // 100 featured: 2,076 (walks the publication index)
  'latest-summaries': 1_500, // 100 latest: 837
  'listing-detail': 100,
  'listing-name-order': 12_000, // `other`: 8,605 (3 rows per member)
  'listing-name-page-items': 1_200, // 100 ids: ~900
  'navigation-next': 20,
  'navigation-previous': 20,
  'publication-version': 5, // 2 index seeks
  'published-summaries': 35_000, // 28,183, cached per epoch for sitemaps and the feed
  'related-shared-categories': 3_000, // worst listing: 2,172
  'related-single-category-members': 500,
  'related-single-category-seek': 200,
  'search-summaries': 17_000, // worst: a term that matches category names only
  'shell-stats': 20_000, // 15,242, cached per epoch
  'unpublished-listing': 10
}

let stateDirectory: string
let dispose: (() => Promise<void>) | undefined
let db: D1Database
const events: Array<CatalogCacheEvent | CatalogQueryEvent> = []
const called = new Set<string>()
const operationNames: string[] = []

/** Records which methods of an operations object ran, for the coverage check. */
function tracked<T extends object>(prefix: string, operations: T): T {
  for (const name of Object.keys(operations)) operationNames.push(`${prefix}.${name}`)
  return new Proxy(operations, {
    get(target, property) {
      const value = Reflect.get(target, property)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        called.add(`${prefix}.${String(property)}`)
        return value.apply(target, args)
      }
    }
  })
}

/** The D1 binding with every statement checked against D1's limits before it reaches D1. */
function checked(binding: D1Database): D1Database {
  return new Proxy(binding, {
    get(target, property) {
      if (property === 'prepare') {
        return (sql: string) => {
          assertD1StatementLimits(sql)
          const statement = target.prepare(sql)
          return new Proxy(statement, {
            get(inner, key) {
              if (key === 'bind') {
                return (...params: unknown[]) => {
                  assertD1StatementLimits(sql, params)
                  return inner.bind(...params)
                }
              }
              const value = Reflect.get(inner, key)
              return typeof value === 'function' ? value.bind(inner) : value
            }
          })
        }
      }
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
}

function local(command: string): void {
  execFileSync('pnpm', ['tsx', 'scripts/d1-local-guard.ts', command], {
    env: {
      ...process.env,
      HARNESS_D1_STATE_DIRECTORY: stateDirectory,
      WRANGLER_SEND_METRICS: 'false'
    },
    stdio: 'ignore'
  })
}

beforeAll(async () => {
  stateDirectory = mkdtempSync(join(tmpdir(), 'best-serp-co-workerd-queries-'))
  local('migrate')
  local('import')
  const configPath = join(stateDirectory, 'wrangler.jsonc')
  writeFileSync(
    configPath,
    JSON.stringify({
      compatibility_date: '2026-07-13',
      d1_databases: [
        {
          binding: 'DB',
          database_id: project.local.databaseId,
          database_name: project.local.databaseName
        }
      ],
      name: 'best-serp-co-workerd-queries-test'
    })
  )
  const proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath,
    persist: { path: resolve(stateDirectory, 'drizzle', 'best-serp-co', 'v3') }
  })
  dispose = () => proxy.dispose()
  db = proxy.env.DB
}, 240_000)

afterAll(async () => {
  await dispose?.()
  if (stateDirectory) rmSync(stateDirectory, { force: true, recursive: true })
})

function catalog() {
  return tracked(
    'catalog',
    createCatalogOperations({
      cache: noCatalogDataCache,
      client: createDatabase(checked(db)),
      clock: () => NOW,
      observe: event => events.push(event)
    })
  )
}

describe('every query on Wrangler-local D1 with the full catalog (#77)', () => {
  it('serves every catalog read within its rows-read budget', async () => {
    const ops = catalog()
    await ops.getPublicationVersion()
    expect((await ops.getShellStats()).listingCount).toBe(3422)
    expect((await ops.getActiveCategories()).length).toBeGreaterThan(100)
    expect(await ops.getCategoryBySlug('other')).toMatchObject({ slug: 'other' })
    expect(await ops.getFeaturedListingCount()).toBeGreaterThan(0)
    expect(await ops.getFeaturedListings(10_000)).toHaveLength(100)
    expect(await ops.getLatestListings(10_000)).toHaveLength(100)
    expect(await ops.getPublishedListings()).toHaveLength(3422)
    expect(await ops.getSitemapListings()).toHaveLength(3422)
    for (const query of [
      { page: 1 },
      { page: 999 },
      { category: 'other', page: 1, pageSize: 100 },
      { category: 'other', page: 29, pageSize: 100 },
      { category: 'plagiarism-checker' },
      { category: 'no-such-category' }
    ]) {
      await ops.getListingNamePage(query)
    }
    // The detail shapes: several categories (worst related scan), one dense and one small
    // category, and a slug that does not exist.
    for (const slug of [
      'jasper.ai',
      'myfreecams-downloader',
      'automatic.chat',
      'ouriginal.com',
      'does-not-exist.example'
    ]) {
      await ops.getListingBySlug(slug)
    }
    expect(await ops.getUnpublishedListing('jasper.ai')).toBeNull()
    expect(await ops.getCanonicalSlugForRedirect('x'.repeat(300))).toBeNull()
  }, 120_000)

  it('answers every search, however long or odd, with one bounded statement', async () => {
    const ops = catalog()
    const queries = [
      'video downloader',
      'ai',
      'a'.repeat(5_000),
      Array.from({ length: 200 }, (_, index) => `word${index}`).join(' '),
      'best free online ai video image tool editor generator for youtube and more',
      'the best free online video downloader for youtube',
      '视频下载器'.repeat(60),
      '🎬'.repeat(200),
      `%_\\'"; DROP TABLE listings; --`,
      'ÉLAN Café Ünïcode'
    ]
    for (const query of queries) {
      const results = await ops.searchListings(query, 10_000)
      expect(results.length, query.slice(0, 30)).toBeLessThanOrEqual(MAX_SEARCH_LIMIT)
    }
    expect((await ops.searchListings('video downloader')).length).toBeGreaterThan(0)
    expect(await ops.searchListings('  \n\t ')).toEqual([])
    expect((await ops.getAutocomplete('jas', 5)).length).toBeLessThanOrEqual(5)
  }, 120_000)

  it('runs the account, email, and submission operations with worst-case inputs', async () => {
    const client = createDatabase(checked(db))
    const longEmail = `${'a'.repeat(240)}@example.com`
    await db
      .prepare(
        "INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES ('wq_user', 'U', ?, 1, 0, 0)"
      )
      .bind(longEmail)
      .run()
    const auth = tracked(
      'auth',
      createAuthOperations({ client, clock: () => NOW, rateLimitKey: 'workerd-queries-'.repeat(3) })
    )
    const rules = Array.from({ length: 16 }, (_, index) => ({
      key: `${longEmail}\0${index}`,
      max: 3,
      scope: `scope-${index}`,
      windowMs: 60_000 * (index + 1)
    }))
    expect((await auth.consumeRateLimit(rules)).allowed).toBe(true)
    expect(await auth.getAdminStatus('wq_user')).toMatchObject({ allowlisted: false })
    expect(await auth.syncUserRole('wq_user')).toBe('user')
    expect(await auth.isAllowlistedEmail(longEmail)).toBe(false)
    expect(await auth.findVerifiedAccount(longEmail)).toEqual({ id: 'wq_user' })

    const email = tracked('email', createEmailDeliveryLedger({ client, clock: () => NOW }))
    const eventKey = `k${'x'.repeat(199)}`
    expect(await email.claim({ eventKey, provider: 'usesend', templateId: 'audit' })).toMatchObject(
      {
        outcome: 'claimed'
      }
    )
    expect(
      await email.complete({
        attempt: 1,
        eventKey,
        providerMessageId: 'm'.repeat(256),
        status: 'sent',
        templateId: 'audit'
      })
    ).toBe(true)

    const submissions = tracked(
      'submissions',
      createSubmissionOperations({ client, clock: () => NOW })
    )
    await submissions.consumeRateLimit(`fingerprint-${'f'.repeat(500)}`)
    const created = await submissions.createSubmission({
      category: 'other',
      content: 'c'.repeat(5_000),
      description: 'd'.repeat(300),
      faqs: Array.from({ length: 5 }, (_, index) => ({
        answer: 'a'.repeat(1_200),
        question: `${'q'.repeat(150)}${index}?`
      })),
      logoUrl: 'https://workerd-queries.example/logo.png',
      name: 'n'.repeat(120),
      resourceLinks: Array.from({ length: 5 }, (_, index) => ({
        label: 'l'.repeat(80),
        url: `https://workerd-queries.example/${index}`
      })),
      website: 'https://workerd-queries.example/'
    })
    expect(await submissions.getSubmission(created.id, created.token)).toMatchObject({
      status: 'pending_badge'
    })
    await submissions.beginVerification(created.id, created.token)
    expect(
      await submissions.finishVerification(created.id, created.token, {
        code: 'badge_missing',
        ok: false
      })
    ).toMatchObject({ verificationAttempts: 1 })
    expect(await submissions.getReviewPreview({ id: created.id, token: created.token })).toBeNull()
  }, 120_000)

  it('kept every catalog query successful and within its budget, and ran every operation', () => {
    const queries = events.filter((event): event is CatalogQueryEvent => event.event === 'd1_query')
    expect(queries.length).toBeGreaterThan(30)
    const worst = new Map<CatalogQueryShape, number>()
    for (const query of queries) {
      expect(query.success, query.queryShape).toBe(true)
      expect(query.rowsRead, query.queryShape).not.toBeNull()
      worst.set(query.queryShape, Math.max(worst.get(query.queryShape) ?? 0, query.rowsRead ?? 0))
    }
    console.info(JSON.stringify({ event: 'workerd_rows_read', worst: Object.fromEntries(worst) }))
    const overBudget = [...worst].filter(([shape, rows]) => rows > ROWS_READ_BUDGET[shape])
    expect(overBudget, JSON.stringify(Object.fromEntries(worst))).toEqual([])
    expect(operationNames.filter(name => !called.has(name))).toEqual([])
  })
})

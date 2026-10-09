import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { getPlatformProxy } from 'wrangler'
import { createAuthOperations } from '../apps/web/src/db/auth'
import { noCatalogDataCache } from '../apps/web/src/db/cache'
import {
  createCatalogOperations,
  MAX_SEARCH_LIMIT,
  normalizeSearchQuery
} from '../apps/web/src/db/catalog'
import { createDatabase } from '../apps/web/src/db/client'
import type {
  CatalogCacheEvent,
  CatalogQueryEvent,
  CatalogQueryShape
} from '../apps/web/src/db/contracts'
import { createDraftJobOperations } from '../apps/web/src/db/draft-jobs'
import { createEmailDeliveryLedger } from '../apps/web/src/db/email-deliveries'
import { assertD1StatementLimits } from '../apps/web/src/db/sql-limits'
import { createSubmissionOperations } from '../apps/web/src/db/submissions'
import {
  AFFILIATE_HOST,
  CATCH_ALL_CATEGORY,
  generateScaleCatalog,
  isPublicListing,
  type ScaleListing,
  scaleCatalogStatements
} from './fixtures/scale-catalog'
import { project } from './project'

vi.mock('server-only', () => ({}))

/**
 * Every catalog, search, account, email, and submission query against Wrangler-local D1
 * (workerd) with a generated catalog at production scale (`fixtures/scale-catalog.ts`, #314)
 * and worst-case inputs (#77). node:sqlite applies none of D1's limits; workerd applies most of
 * them, and each statement also passes `assertD1StatementLimits` (which adds the 32-argument
 * function limit workerd skips). The hot catalog queries have a rows-read budget each, so a plan
 * regression or a full scan fails here instead of on the bill. The last test checks that every
 * operation ran.
 */
const NOW = new Date('2026-10-06T12:00:00.000Z')

/**
 * Most rows one statement of each shape may read on the generated catalog, which has the v1
 * import's size and shape (3,422 public listings, 3,777 public memberships, 141 active
 * categories); the budgets are the ones set on the import (#77). Values measured on the generated
 * catalog are in the comments; the budgets leave room for growth but not for a lost index or a
 * full scan of a larger table.
 */
const ROWS_READ_BUDGET: Record<CatalogQueryShape, number> = {
  'canonical-redirect': 10, // a redirect: 2
  'legacy-root-target': 10, // worker-entry slug seek; not run by this suite
  'category-summaries': 2_000,
  'featured-summaries': 2_500, // 100 featured: 1,887 (walks the publication index)
  'latest-summaries': 1_500, // 100 latest: 829
  'listing-detail': 100, // the most FAQs, links and images: 37
  'listing-name-order': 12_000, // `other`: 8,854 (3 rows per member)
  'listing-name-page-items': 1_200, // 100 ids: ~900
  'navigation-next': 20,
  'navigation-previous': 20,
  'publication-version': 5, // 2 index seeks
  'published-summaries': 35_000, // 28,203, cached per epoch for sitemaps and the feed
  'related-shared-categories': 3_000, // worst listing: 2,401
  'related-single-category-members': 500, // 104
  'related-single-category-seek': 200,
  'search-summaries': 17_000, // worst: a term that matches category names only: 15,520
  'shell-stats': 20_000, // 15,243, cached per epoch
  'unpublished-listing': 10, // a hit, in one category like all of #100's and #104's: 8
  'unpublished-listing-status': 10 // worker-entry slug seek; not run by this suite
}

/** The generated catalog, and the facts the assertions name, all read from its rows. */
const scale = generateScaleCatalog()
const live = scale.listings.filter(listing => isPublicListing(listing, NOW.toISOString()))
const categoryBySlug = new Map(scale.categories.map(category => [category.slug, category]))
/** Members per category: public ones (the shell counts), and all (what a related scan reads). */
const publicMembers = new Map<string, number>()
const allMembers = new Map<string, number>()
const isLive = new Set(live)
for (const listing of scale.listings) {
  for (const slug of listing.categories) {
    allMembers.set(slug, (allMembers.get(slug) ?? 0) + 1)
    if (isLive.has(listing)) publicMembers.set(slug, (publicMembers.get(slug) ?? 0) + 1)
  }
}
const onlyIn = (slug: string) =>
  live.find(listing => listing.categories.length === 1 && listing.categories[0] === slug)
const first = <T>(values: T[], label: string): T => {
  if (values[0] === undefined) throw new Error(`The scale catalog has no ${label}.`)
  return values[0]
}
const sharedMembers = (listing: ScaleListing) =>
  listing.categories.reduce((total, slug) => total + (allMembers.get(slug) ?? 0), 0)
/** The worst related scan: several categories with the most members between them. */
const widest = first(
  live
    .filter(listing => listing.categories.length > 1)
    .sort((left, right) => sharedMembers(right) - sharedMembers(left)),
  'listing in several categories'
)
/** A listing filed only under the catch-all: the related query walks the name index. */
const dense = first(
  live.filter(
    listing => listing.categories.length === 1 && listing.categories[0] === CATCH_ALL_CATEGORY
  ),
  'listing only in the catch-all'
)
/**
 * The largest category the related query still reads member by member (at most 128 public
 * members, `RELATED_MEMBER_SCAN_LIMIT` in `catalog.ts`), with a listing filed only there.
 */
const small = first(
  [...publicMembers]
    .filter(([slug, size]) => size <= 128 && onlyIn(slug))
    .sort((left, right) => right[1] - left[1])
    .map(([slug]) => ({ listing: onlyIn(slug) as ScaleListing, slug })),
  'small category'
)
/** The listing with the most FAQs, resource links and images: the largest detail statement. */
const richness = new Map<string, number>()
for (const { listingId } of [...scale.faqs, ...scale.resources, ...scale.media]) {
  richness.set(listingId, (richness.get(listingId) ?? 0) + 1)
}
const richest = first(
  [...live].sort((left, right) => (richness.get(right.id) ?? 0) - (richness.get(left.id) ?? 0)),
  'listing with FAQs'
)
const unpublishedOf = (retired: boolean) =>
  scale.listings
    .filter(
      listing =>
        listing.status === 'approved' &&
        !listing.isActive &&
        listing.categories.some(slug => !categoryBySlug.get(slug)?.isActive) === retired
    )
    .sort((left, right) => right.categories.length - left.categories.length)
/**
 * Unpublished in the most categories (the 410 page's worst lookup), and unpublished under a
 * retired category (a 404, #260).
 */
const unpublished = first(unpublishedOf(false), 'unpublished listing')
const retired = first(unpublishedOf(true), 'listing of a retired category')
const redirect = first(scale.redirects, 'slug redirect')
/** A listing whose slug is its domain, while its website is an affiliate link (#81). */
const domain = first(
  live.filter(
    listing => listing.slug.endsWith('.test') && listing.website.includes(AFFILIATE_HOST)
  ),
  'domain listing'
)
const stem = domain.slug.replace(/\.test$/u, '')
const unicode = first(
  live.filter(listing => listing.description.includes('OÜ')),
  'non-ASCII listing'
)

/**
 * The search contract (DATA_MODEL.md, #81) on the generated rows: every term in the public
 * listing's name, short description or slug, or in an active category's slug or name, never its
 * website; ASCII letters folded as SQLite's `lower()` does, other characters as typed; exact
 * matches first, then names starting with the query, then names containing it, then by name and
 * slug in binary order.
 */
function expectedSearch(query: string, limit = MAX_SEARCH_LIMIT): string[] {
  const { phrase, terms } = normalizeSearchQuery(query)
  const fold = (value: string) => value.replace(/[A-Z]+/gu, letters => letters.toLowerCase())
  const matches = live.filter(listing =>
    terms.every(
      term =>
        [listing.name, listing.description, listing.slug].some(value =>
          fold(value).includes(term)
        ) ||
        listing.categories.some(slug => {
          const category = categoryBySlug.get(slug)
          return (
            category?.isActive &&
            (fold(category.slug).includes(term) || fold(category.name).includes(term))
          )
        })
    )
  )
  const rank = (listing: ScaleListing) => {
    const name = fold(listing.name)
    if (name === phrase || fold(listing.slug) === phrase) return 0
    return name.startsWith(phrase) ? 1 : name.includes(phrase) ? 2 : 3
  }
  const binary = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0)
  return matches
    .sort(
      (left, right) =>
        rank(left) - rank(right) || binary(left.name, right.name) || binary(left.slug, right.slug)
    )
    .slice(0, limit)
    .map(listing => listing.slug)
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

/** Loads the generated catalog through the D1 binding, each statement within D1's limits. */
async function seed(binding: D1Database): Promise<void> {
  const statements = scaleCatalogStatements(scale)
  for (let start = 0; start < statements.length; start += 250) {
    await binding.batch(
      statements.slice(start, start + 250).map(({ params, sql }) => {
        assertD1StatementLimits(sql, params)
        return binding.prepare(sql).bind(...params)
      })
    )
  }
}

beforeAll(async () => {
  stateDirectory = mkdtempSync(join(tmpdir(), 'best-serp-co-workerd-queries-'))
  local('migrate')
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
  await seed(db)
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

describe('every query on Wrangler-local D1 with a catalog at production scale (#77, #314)', () => {
  it('serves every catalog read within its rows-read budget', async () => {
    const ops = catalog()
    const catchAllSize = publicMembers.get(CATCH_ALL_CATEGORY) as number
    await ops.getPublicationVersion()
    expect(live.length).toBeGreaterThanOrEqual(3_422)
    expect((await ops.getShellStats()).listingCount).toBe(live.length)
    expect(await ops.getActiveCategories()).toHaveLength(
      scale.categories.filter(category => category.isActive).length
    )
    expect(await ops.getCategoryBySlug(CATCH_ALL_CATEGORY)).toMatchObject({
      count: catchAllSize,
      slug: CATCH_ALL_CATEGORY
    })
    expect(await ops.getFeaturedListingCount()).toBe(
      live.filter(listing => listing.isFeatured).length
    )
    expect(await ops.getFeaturedListings(10_000)).toHaveLength(100)
    expect(await ops.getLatestListings(10_000)).toHaveLength(100)
    expect(await ops.getPublishedListings()).toHaveLength(live.length)
    expect(await ops.getSitemapListings()).toHaveLength(live.length)
    const lastCatchAllPage = Math.ceil(catchAllSize / 100)
    for (const query of [
      { page: 1 },
      { page: 999 },
      { category: CATCH_ALL_CATEGORY, page: 1, pageSize: 100 },
      { category: CATCH_ALL_CATEGORY, page: lastCatchAllPage, pageSize: 100 },
      { category: small.slug },
      { category: 'no-such-category' }
    ]) {
      await ops.getListingNamePage(query)
    }
    // The detail shapes: several categories (worst related scan), one dense and one small
    // category, the most FAQs, links and images, an unpublished listing, and a slug that does
    // not exist.
    for (const slug of [
      widest.slug,
      dense.slug,
      small.listing.slug,
      richest.slug,
      unpublished.slug,
      'does-not-exist.test'
    ]) {
      await ops.getListingBySlug(slug)
    }
    expect(await ops.getListingBySlug(widest.slug)).toMatchObject({ slug: widest.slug })
    expect(await ops.getListingBySlug(unpublished.slug)).toBeNull()
    expect(await ops.getUnpublishedListing(widest.slug)).toBeNull()
    expect(await ops.getUnpublishedListing(unpublished.slug)).toMatchObject({
      slug: unpublished.slug
    })
    expect(await ops.getUnpublishedListing(retired.slug)).toBeNull()
    expect(await ops.getCanonicalSlugForRedirect('x'.repeat(300))).toBeNull()
    expect(await ops.getCanonicalSlugForRedirect(redirect.oldSlug)).toBe(redirect.newSlug)
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
    const slugsFor = async (query: string) =>
      (await ops.searchListings(query, 100)).map(listing => listing.slug)
    // Exactly the contract's matches, in its order.
    const smallCategory = categoryBySlug.get(small.slug)?.name as string
    for (const query of ['video downloader', 'ly', domain.slug, stem, smallCategory, 'OÜ']) {
      expect(await slugsFor(query), query).toEqual(expectedSearch(query))
    }
    // A product's domain finds it through the slug, first (owner decision, #81).
    expect((await slugsFor(domain.slug))[0]).toBe(domain.slug)
    expect(await slugsFor(stem)).toContain(domain.slug)
    // The website URL is not searched: nearly every website is an affiliate link on one host
    // (production's are serp.ly links), so matching it would return every listing (#81 round 2).
    expect(live.filter(listing => listing.website.includes(AFFILIATE_HOST)).length).toBeGreaterThan(
      3_000
    )
    expect(await slugsFor(AFFILIATE_HOST)).toEqual([])
    expect(await slugsFor('example')).toEqual([])
    expect(await slugsFor('ly')).toHaveLength(MAX_SEARCH_LIMIT)
    // Non-ASCII letters match as typed, the way SQLite's lower() leaves them (#81 review).
    expect(await slugsFor('OÜ')).toContain(unicode.slug)
    expect(await ops.searchListings('  \n\t ')).toEqual([])
    expect((await ops.getAutocomplete(stem.slice(0, 3), 5)).length).toBeLessThanOrEqual(5)
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
    // Native intake (#63) with the longest values the form and the API accept.
    const owner = 'wq_user'
    const website = `https://workerd-queries.example/${'p'.repeat(1_900)}`
    const content = {
      categorySlug: CATCH_ALL_CATEGORY,
      content: 'c'.repeat(5_000),
      description: 'd'.repeat(160),
      logoUrl: `https://workerd-queries.example/${'l'.repeat(1_900)}.png`,
      name: 'n'.repeat(120)
    }
    expect(await submissions.checkUrl(website, owner)).toMatchObject({ kind: 'available' })
    expect(await submissions.checkUrl(`https://www.${domain.slug}/pricing`, owner)).toMatchObject({
      kind: 'listed',
      listing: { public: true, slug: domain.slug }
    })
    const draft = await submissions.createDraft({
      ownerUserId: owner,
      submission: { ...content, website }
    })
    expect(draft).toMatchObject({ plan: null, status: 'draft' })
    await submissions.updateDraft({
      content: { ...content, name: 'm'.repeat(120) },
      expectedContentVersion: draft.contentVersion,
      ownerUserId: owner,
      submissionId: draft.id
    })
    expect(await submissions.getOwnSubmission(draft.id, owner)).toMatchObject({
      contentVersion: 2
    })
    expect(await submissions.chooseFreePlan(draft.id, owner)).toMatchObject({
      status: 'pending_badge'
    })
    const { claimedAt } = await submissions.claimVerification(draft.id, owner)
    expect(
      await submissions.finishVerification(draft.id, owner, claimedAt, {
        code: 'badge_missing',
        ok: false
      })
    ).toMatchObject({ verificationAttempts: 1 })

    // The daily draft job (#63): a reminder at +13 hours, expiry after 30 days. The generated
    // catalog's own drafts are due too; these checks follow this test's two submissions.
    const waiting = await submissions.createDraft({
      ownerUserId: owner,
      submission: { ...content, website: 'https://workerd-queries-2.example/' }
    })
    expect(await submissions.listOwnSubmissions(owner, 10_000)).toHaveLength(2)
    const jobs = tracked('draftJobs', createDraftJobOperations({ client }))
    const later = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000).toISOString()
    const ours = <T extends { id: string }>(items: T[]) =>
      items.filter(item => item.id === draft.id || item.id === waiting.id)
    const due = await jobs.remindersDue({ limit: 100, now: later(13) })
    expect(ours(due).map(item => [item.id, item.reminder])).toEqual([[waiting.id, 1]])
    expect(
      await jobs.claimReminder({
        now: later(13),
        reminder: 1,
        submissionId: waiting.id,
        variant: 'choose_plan'
      })
    ).toBe(true)
    expect(
      ours(await jobs.expiredDrafts({ limit: 100, now: later(31 * 24) })).map(item => item.id)
    ).toEqual([waiting.id])
    expect(await jobs.expireDraft({ now: later(31 * 24), submissionId: waiting.id })).toBe(true)
    expect(await jobs.retryableEmails({ limit: 100, maxAttempts: 5, now: later(31 * 24) })).toEqual(
      []
    )
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
    // Every budget was measured: the generated catalog reaches every shape this suite runs. The
    // two worker-entry seeks run elsewhere, and no catalog query issues `category-summaries` now.
    expect(
      (Object.keys(ROWS_READ_BUDGET) as CatalogQueryShape[]).filter(shape => !worst.has(shape))
    ).toEqual(['legacy-root-target', 'category-summaries', 'unpublished-listing-status'])
    expect(operationNames.filter(name => !called.has(name))).toEqual([])
  })
})

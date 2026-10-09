/**
 * Listing domain check (serpcompany/best.serp.co#100). Read-only and repeatable.
 *
 *   pnpm catalog:domains                 follow every live listing's website, classify it, and
 *                                        write d1/hygiene/<date>-listing-domains.yaml
 *   pnpm catalog:domains -- --reuse      reuse the observations cached in .runtime/listing-domains/
 *                                        and fetch only the listings missing there (resumes an
 *                                        interrupted run; reclassifies without the network)
 *   pnpm catalog:domains -- manifest     write the reviewed publication manifest that unpublishes
 *                                        the report's `unpublish` list
 *   pnpm catalog:domains -- decisions-manifest
 *                                        write the manifest that unpublishes the owner's decisions
 *                                        in d1/hygiene/<date>-owner-list-decisions.yaml
 *   pnpm catalog:domains -- adult-manifest
 *                                        write the manifests that take the adult listings in
 *                                        d1/hygiene/<date>-adult-decisions.yaml off the site and
 *                                        retire their category (#260)
 *   pnpm catalog:domains -- dead-manifest --since <date>
 *                                        write the manifest that unpublishes listings whose domain
 *                                        does not exist in the --since report and in
 *                                        d1/hygiene/<date>-dead-domains.recheck.yaml
 *
 * Listings come from the reviewed import (`d1/artifacts`), the catalog both environments were
 * bootstrapped from. Each manifest operation carries the website it was checked against, so the
 * publisher refuses any listing that changed since (`listing-unpublish` `expected`).
 *
 * Options: --date YYYY-MM-DD, --concurrency N, --only slug[,slug].
 *
 * The manifest is row-level (`concurrency: rows`): it names no base version, and each operation
 * checks its listing's website, categories, and live state, so one file applies on staging and
 * production in any order, whatever else each environment published.
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { parse, stringify } from 'yaml'
import { freshMigrationNames, freshMigrationsDirectory } from './d1-drizzle-local'
import { readParityReport, readReviewedImportSql } from './d1-import-artifact'
import { buildPublicationPlan, type PublicationBase, parseManifest } from './d1-publisher'
import {
  type CheckedListing,
  type Classification,
  classifyListing,
  type DomainClass,
  domainClasses,
  isRedirectorHost,
  ownDomainUrl,
  unpublishClasses
} from './listing-domain-classifier'
import { isTransient, type SiteObservation, traceWebsite } from './listing-domain-fetch'

export interface CatalogListing extends CheckedListing {
  categories: string[]
}

/** The reviewed import in an in-memory database: the fresh migrations, then the committed SQL. */
export function reviewedImportDatabase(): DatabaseSync {
  const database = new DatabaseSync(':memory:')
  for (const migration of freshMigrationNames()) {
    database.exec(readFileSync(resolve(freshMigrationsDirectory, migration), 'utf8'))
  }
  database.exec(readReviewedImportSql(readParityReport()))
  return database
}

/** A database's live listings, with their active categories in order. */
export function liveListings(database: DatabaseSync): CatalogListing[] {
  const rows = database
    .prepare(
      `SELECT l.id,l.slug,l.name,l.description,l.website,
        (SELECT json_group_array(slug) FROM (SELECT c.slug FROM listing_categories lc
          JOIN categories c ON c.id=lc.category_id
          WHERE lc.listing_id=l.id AND c.is_active=1 ORDER BY lc.sort_order)) AS categories
      FROM listings l WHERE l.status='approved' AND l.is_active=1 ORDER BY l.slug`
    )
    .all() as Array<Record<string, string>>
  return rows.map(row => ({
    categories: JSON.parse(row.categories ?? '[]') as string[],
    description: row.description ?? '',
    id: row.id ?? '',
    name: row.name ?? '',
    slug: row.slug ?? '',
    website: row.website ?? ''
  }))
}

/** Live listings of the reviewed import, with their active categories in order. */
export function reviewedImportListings(): CatalogListing[] {
  const database = reviewedImportDatabase()
  try {
    return liveListings(database)
  } finally {
    database.close()
  }
}

/** Committed publication manifests in file (date) order; other tests write temporary ones there. */
export function committedPublications(): string[] {
  return execFileSync('git', ['ls-files', 'd1/publications'], { encoding: 'utf8' })
    .split('\n')
    .filter(path => path.endsWith('.yaml'))
    .sort()
}

/**
 * Applies a manifest to `database` as the publisher's batch would, at the database's publication
 * state, in one transaction: it applies whole or throws and writes nothing.
 */
export function applyManifest(database: DatabaseSync, source: string, now: string): void {
  const live = database
    .prepare('SELECT version, checksum FROM publication_state WHERE id = 1')
    .get() as unknown as PublicationBase
  const plan = buildPublicationPlan(parseManifest(source), source, now, live)
  database.exec('BEGIN')
  try {
    for (const item of plan.statements)
      database
        .prepare(item.query)
        .run(
          ...(item.bindings.map(value =>
            typeof value === 'boolean' ? Number(value) : value
          ) as SQLInputValue[])
        )
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

/** What decides which listings are live and which categories they are filed under. */
const catalogShapingActions = new Set([
  'listing-categories-add',
  'listing-unpublish',
  'category-unpublish'
])

/**
 * The reviewed import with every committed manifest that changes which listings are live or what
 * categories they are filed under applied in file order, as staging and production publish them
 * (#260): #98's manifest gave 14 adult downloaders the Adult category, which their unpublish must
 * expect, and a listing another manifest unpublishes is no longer live. `exclude` names manifest
 * ids to leave out: the ones being generated.
 */
export function reviewedCatalogDatabase(exclude: readonly string[] = []): DatabaseSync {
  const database = reviewedImportDatabase()
  try {
    for (const path of committedPublications()) {
      const source = readFileSync(resolve(path), 'utf8')
      const manifest = parseManifest(source)
      if (exclude.includes(manifest.id)) continue
      if (!manifest.operations.some(op => catalogShapingActions.has(op.action))) continue
      try {
        applyManifest(database, source, '2026-10-09T00:00:00.000Z')
      } catch (error) {
        throw new Error(`${path} does not apply after the manifests before it: ${error}`)
      }
    }
    return database
  } catch (error) {
    database.close()
    throw error
  }
}

/** Live listings of the reviewed catalog (`reviewedCatalogDatabase`). */
export function reviewedCatalogListings(exclude: readonly string[] = []): CatalogListing[] {
  const database = reviewedCatalogDatabase(exclude)
  try {
    return liveListings(database)
  } finally {
    database.close()
  }
}

export interface ReportEntry {
  slug: string
  id: string
  website: string
  class: DomainClass
  finalUrl: string
  status: number | string
  reason: string
  marker?: string
}

export interface DomainReport {
  generatedAt: string
  source: string
  counts: Record<DomainClass, number>
  unpublish: ReportEntry[]
  ownerReview: ReportEntry[]
}

const shortUrl = (url: string) => (url.length > 120 ? `${url.slice(0, 117)}...` : url)

export function reportEntry(
  listing: CheckedListing,
  link: SiteObservation,
  classification: Classification,
  own?: SiteObservation | null
): ReportEntry {
  const observation = classification.source === 'own-domain' && own ? own : link
  return {
    slug: listing.slug,
    id: listing.id,
    website: listing.website,
    class: classification.class,
    finalUrl: shortUrl(observation.finalUrl),
    status: observation.status ?? observation.error ?? observation.result,
    reason: classification.reason,
    ...(classification.marker ? { marker: classification.marker } : {})
  }
}

export interface CheckedEntry {
  listing: CheckedListing
  observation: SiteObservation
  /** The listing's own domain fetched directly, when its link never reached it. */
  own?: SiteObservation | null
}

export function buildReport(
  checked: ReadonlyArray<CheckedEntry>,
  generatedAt: string,
  source: string
): DomainReport {
  const counts = Object.fromEntries(domainClasses.map(name => [name, 0])) as Record<
    DomainClass,
    number
  >
  const unpublish: ReportEntry[] = []
  const ownerReview: ReportEntry[] = []
  for (const { listing, observation, own } of [...checked].sort((a, b) =>
    a.listing.slug < b.listing.slug ? -1 : a.listing.slug > b.listing.slug ? 1 : 0
  )) {
    const classification = classifyListing(listing, observation, own)
    counts[classification.class] += 1
    if (classification.class === 'ok') continue
    const entry = reportEntry(listing, observation, classification, own)
    if (unpublishClasses.has(classification.class)) unpublish.push(entry)
    else ownerReview.push(entry)
  }
  return { generatedAt, source, counts, unpublish, ownerReview }
}

const REPORT_HEADER = `# serpcompany/best.serp.co#100: what each live listing's website shows (scripts/listing-domain-check.ts).
# unpublish: gambling, betting, or spam pages, and parked or for-sale domains (owner decision of
# 2026-10-06), the operations of the matching d1/publications manifest. ownerReview: listings
# that end on another company's domain or are unreachable; the owner decides each, nothing is
# unpublished automatically. Listings classified ok are counted only.
`

export function renderReport(report: DomainReport): string {
  return `${REPORT_HEADER}${stringify(report, { lineWidth: 0 })}`
}

export interface ManifestOptions {
  id: string
  reportPath: string
}

/** One row-level `listing-unpublish` per entry, guarded by the website it was checked against. */
function unpublishOperations<Entry extends Pick<ReportEntry, 'id' | 'slug' | 'website'>>(
  entries: readonly Entry[],
  listings: readonly CatalogListing[],
  reason: (entry: Entry) => string
) {
  const byId = new Map(listings.map(listing => [listing.id, listing]))
  const operations = entries.map(entry => {
    const listing = byId.get(entry.id)
    if (!listing || listing.slug !== entry.slug || listing.website !== entry.website)
      throw new Error(`${entry.slug} no longer matches the reviewed catalog; rerun the check.`)
    return {
      action: 'listing-unpublish',
      id: listing.id,
      slug: listing.slug,
      categories: listing.categories,
      reason: reason(entry).slice(0, 200),
      expected: { website: listing.website }
    }
  })
  if (operations.length === 0) throw new Error('The report lists nothing to unpublish.')
  return operations
}

/** A row-level manifest the publisher accepts (planned at the import's state), or an error. */
function manifestSource(header: string, id: string, operations: unknown[]): string {
  const manifest = {
    version: 1,
    id,
    concurrency: 'rows',
    provenance: {
      actor: 'devinschumacher',
      workflow: 'github/publish-d1'
    },
    operations
  }
  const source = `${header}${stringify(manifest, { lineWidth: 0 })}`
  buildPublicationPlan(parseManifest(source), source, new Date().toISOString(), {
    checksum: 'a'.repeat(64),
    version: 1
  })
  return source
}

/** The publication manifest that unpublishes a report's `unpublish` list. */
export function buildUnpublishManifest(
  report: DomainReport,
  listings: readonly CatalogListing[],
  options: ManifestOptions
): string {
  const operations = unpublishOperations(report.unpublish, listings, entry => {
    const label = entry.class === 'parking' ? 'parked or for sale' : 'gambling, betting, or spam'
    return `#100 hijacked domain, ${label}: ${entry.marker ?? entry.reason}`
  })
  const header = `# serpcompany/best.serp.co#100: unpublish ${operations.length} listings whose domain is hijacked (gambling, betting,
# or spam), parked, or for sale, as the owner decided on 2026-10-06. Their pages answer 410 Gone and
# leave the sitemap, search, and RSS; the rows stay (Republish in /admin brings one back).
# Evidence: ${options.reportPath}.
# Generated by \`pnpm catalog:domains -- manifest\`. Row-level: each operation refuses a listing whose
# website or categories changed since, or that is no longer live or has its own submission in
# review, and it names no base version, so it publishes in any order relative to #98's and #105's
# manifests. Apply staging first, then production after promotion.
`
  return manifestSource(header, options.id, operations)
}

const deadDomain = (entry: ReportEntry) =>
  entry.class === 'unreachable' && entry.status === 'ENOTFOUND'

/**
 * Owner-list listings whose host does not exist (DNS NXDOMAIN, for the link and, when it differs,
 * the listing's own domain) in both reports, with the same website: the owner decided on
 * 2026-10-07 (#104) that a domain gone in two checks a day or more apart is a dead product.
 * Every other unreachable listing (an HTTP error, a timeout, TLS) stays on the owner list.
 */
export function deadDomainEntries(earlier: DomainReport, recheck: DomainReport): ReportEntry[] {
  const before = new Map(earlier.ownerReview.filter(deadDomain).map(entry => [entry.id, entry]))
  return recheck.ownerReview.filter(
    entry => deadDomain(entry) && before.get(entry.id)?.website === entry.website
  )
}

/** The owner's reviewed decisions on owner-list listings (#104): each one is unpublished. */
export interface OwnerListDecisions {
  decidedAt: string
  evidence: string[]
  unpublish: Array<{
    slug: string
    id: string
    website: string
    class: 'gone' | 'trash'
    reason: string
  }>
}

/** The publication manifest that unpublishes the owner's decisions on the owner list. */
export function buildDecisionsManifest(
  decisions: OwnerListDecisions,
  listings: readonly CatalogListing[],
  options: { decisionsPath: string; id: string }
): string {
  for (const entry of decisions.unpublish) {
    if (entry.class !== 'gone' && entry.class !== 'trash')
      throw new Error(`${entry.slug}: class must be gone or trash.`)
  }
  const operations = unpublishOperations(
    decisions.unpublish,
    listings,
    entry => `#104 ${entry.class}: ${entry.reason}`
  )
  const counts = (name: 'gone' | 'trash') =>
    decisions.unpublish.filter(entry => entry.class === name).length
  const header = `# serpcompany/best.serp.co#104: unpublish ${operations.length} owner-list listings, as the owner decided on ${decisions.decidedAt}:
# ${counts('gone')} gone (the site does not work, checked twice) and ${counts('trash')} trash (not the listed product). Their
# pages answer 410 Gone and leave the sitemap, search, and RSS; the rows stay (Republish in /admin).
# Decisions and evidence: ${options.decisionsPath}.
# Generated by \`pnpm catalog:domains -- decisions-manifest\`. Row-level, like the hijacked-domains
# manifest. Apply staging first, then production after promotion.
`
  return manifestSource(header, options.id, operations)
}

/** How an adult listing was found (#260): filed under Adult, or built for an adult site elsewhere. */
export const adultClasses = ['adult-category', 'filed-elsewhere'] as const

/**
 * The owner's decision of 2026-10-09 (#260): best.serp.co lists no adult products. Every listing
 * in the Adult category and every listing built for an adult site goes, and the category retires.
 */
export interface AdultDecisions {
  decidedAt: string
  evidence: string[]
  /**
   * Retired (`category-unpublish`) once their listings are unpublished; kept listings filed under
   * one leave it first (`listing-categories-remove`). The first is the one `category` files under.
   */
  retireCategories: string[]
  unpublish: Array<{
    slug: string
    id: string
    website: string
    class: (typeof adultClasses)[number]
    reason: string
  }>
  /** Listings checked by hand that stay listed, and why (keyword matches, owner exceptions). */
  kept: Array<{ slug: string; reason: string }>
}

export interface AdultManifestOptions {
  decisionsPath: string
  /** The manifest that files decided listings under a retired category first, when any lacks one. */
  categoryId: string
  removalId: string
}

/**
 * The manifests that take adult listings off best.serp.co (#260). An unpublished listing filed
 * under a retired category answers 404, not 410, so every decided listing must be in one:
 * `category` gives the listings that lack one the first retired category as a secondary category
 * (as #98 did for 14 adult downloaders). `removal` takes the retired categories off the kept
 * listings filed under them, unpublishes every decided listing, then retires the categories.
 * Separate files, because a manifest names each listing once; `removal` refuses whole until
 * `category` is published.
 */
export function buildAdultManifests(
  decisions: AdultDecisions,
  listings: readonly CatalogListing[],
  options: AdultManifestOptions
): { category: string | null; removal: string } {
  const retire = decisions.retireCategories
  const [fileUnder] = retire
  if (!fileUnder) throw new Error('retireCategories names no category.')
  for (const entry of decisions.unpublish) {
    if (!adultClasses.includes(entry.class))
      throw new Error(`${entry.slug}: class must be ${adultClasses.join(' or ')}.`)
  }
  const unpublished = new Set(decisions.unpublish.map(entry => entry.slug))
  const kept = new Set(decisions.kept.map(entry => entry.slug))
  for (const slug of kept) {
    if (unpublished.has(slug)) throw new Error(`${slug} is both kept and unpublished.`)
  }
  // A live listing left in a retired category would make its category-unpublish refuse: a decided
  // one is unpublished, and a kept one leaves the category first.
  const detached: CatalogListing[] = []
  for (const listing of listings) {
    const category = listing.categories.find(slug => retire.includes(slug))
    if (!category || unpublished.has(listing.slug)) continue
    if (!kept.has(listing.slug))
      throw new Error(
        `${listing.slug} is live in ${category}: decide it in ${options.decisionsPath}.`
      )
    detached.push(listing)
  }
  const byId = new Map(listings.map(listing => [listing.id, listing]))
  const lacking = decisions.unpublish.flatMap(entry => {
    const listing = byId.get(entry.id)
    return listing && !listing.categories.some(slug => retire.includes(slug)) ? [listing] : []
  })
  const category =
    lacking.length === 0
      ? null
      : manifestSource(
          `# serpcompany/best.serp.co#260: add the ${fileUnder} category, as a secondary category (as #98 did), to the
# ${lacking.length} adult ${lacking.length === 1 ? 'listing' : 'listings'} filed elsewhere without it, so ${options.removalId} unpublishes
# each with the rest and its URL answers 404 once ${fileUnder} retires.
# Decisions: ${options.decisionsPath}.
# Generated by \`pnpm catalog:domains -- adult-manifest\`. Row-level: each operation checks the listing
# still has exactly the categories it lists. Publish it before ${options.removalId}, staging first,
# then production after promotion.
`,
          options.categoryId,
          lacking.map(listing => ({
            action: 'listing-categories-add',
            id: listing.id,
            slug: listing.slug,
            expected: listing.categories,
            add: [fileUnder]
          }))
        )
  // The categories each listing has once `category` is published.
  const filed = listings.map(listing =>
    lacking.includes(listing)
      ? { ...listing, categories: [...listing.categories, fileUnder] }
      : listing
  )
  const operations = [
    // Kept listings leave the retired categories first; a primary one is refused, never removed.
    ...detached.map(listing => ({
      action: 'listing-categories-remove',
      id: listing.id,
      slug: listing.slug,
      expected: listing.categories,
      remove: listing.categories.filter(slug => retire.includes(slug))
    })),
    ...unpublishOperations(decisions.unpublish, filed, entry => `#260 adult: ${entry.reason}`),
    ...retire.map(slug => ({ action: 'category-unpublish', slug }))
  ]
  const counts = (name: AdultDecisions['unpublish'][number]['class']) =>
    decisions.unpublish.filter(entry => entry.class === name).length
  const retiring = `the ${retire.join(' and ')} ${retire.length === 1 ? 'category' : 'categories'}`
  const removal = manifestSource(
    `# serpcompany/best.serp.co#260: best.serp.co lists no adult products (owner decision of ${decisions.decidedAt}).
# Unpublish ${decisions.unpublish.length} adult listings, ${counts('adult-category')} in the ${fileUnder} category and ${counts('filed-elsewhere')} built for an adult site but filed
# elsewhere. Take ${retiring} off the ${detached.length} kept listings filed under them
# (listing-categories-remove), then retire them (category-unpublish: refused while a live listing
# remains in one).
# An unpublished listing filed under a retired category answers 404, not 410, and so does the
# category page; they leave the sitemap, search, RSS, and the submit and edit forms. The rows stay.
# Decisions and evidence: ${options.decisionsPath}.
# Generated by \`pnpm catalog:domains -- adult-manifest\`. Row-level, like the hijacked-domains
# manifest, and disjoint from the other unpublish manifests.${category ? ` Publish ${options.categoryId} first.` : ''}
# Apply staging first, then production after promotion.
`,
    options.removalId,
    operations
  )
  return { category, removal }
}

export interface DeadDomainManifestOptions {
  id: string
  earlierPath: string
  recheckPath: string
}

/** The publication manifest that unpublishes listings whose domain no longer exists. */
export function buildDeadDomainManifest(
  earlier: DomainReport,
  recheck: DomainReport,
  listings: readonly CatalogListing[],
  options: DeadDomainManifestOptions
): string {
  const since = earlier.generatedAt.slice(0, 10)
  const until = recheck.generatedAt.slice(0, 10)
  const operations = unpublishOperations(deadDomainEntries(earlier, recheck), listings, entry => {
    const host = entry.finalUrl.replace(/^https?:\/\//u, '').split('/')[0]
    return `#104 dead domain: ${host} does not exist (DNS), checked ${since} and ${until}`
  })
  const header = `# serpcompany/best.serp.co#104: unpublish ${operations.length} listings whose domain no longer exists (DNS
# NXDOMAIN in both checks, as the owner decided on 2026-10-07). Their pages answer 410 Gone and leave
# the sitemap, search, and RSS; the rows stay (Republish in /admin brings one back).
# Evidence: ${options.earlierPath} and ${options.recheckPath}.
# Generated by \`pnpm catalog:domains -- dead-manifest\`. Row-level, like the hijacked-domains
# manifest. Apply staging first, then production after promotion.
`
  return manifestSource(header, options.id, operations)
}

async function pool<T, R>(
  items: readonly T[],
  concurrency: number,
  work: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const index = next
        next += 1
        results[index] = await work(items[index] as T, index)
      }
    })
  )
  return results
}

interface Arguments {
  command: 'adult-manifest' | 'dead-manifest' | 'decisions-manifest' | 'manifest' | 'scan'
  concurrency: number
  date: string
  only: Set<string> | null
  reuse: boolean
  since: string | null
}

export function parseArguments(argv: readonly string[]): Arguments {
  const args = argv.filter(value => value !== '--')
  const parsed: Arguments = {
    command: 'scan',
    concurrency: 8,
    date: new Date().toISOString().slice(0, 10),
    only: null,
    reuse: false,
    since: null
  }
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]
    const value = () => {
      const next = args[index + 1]
      if (!next || next.startsWith('--')) throw new Error(`${flag} needs a value.`)
      index += 1
      return next
    }
    if (flag === 'manifest' && index === 0) parsed.command = 'manifest'
    else if (flag === 'dead-manifest' && index === 0) parsed.command = 'dead-manifest'
    else if (flag === 'decisions-manifest' && index === 0) parsed.command = 'decisions-manifest'
    else if (flag === 'adult-manifest' && index === 0) parsed.command = 'adult-manifest'
    else if (flag === '--since') parsed.since = value()
    else if (flag === '--reuse') parsed.reuse = true
    else if (flag === '--date') parsed.date = value()
    else if (flag === '--concurrency') parsed.concurrency = Number(value())
    else if (flag === '--only') parsed.only = new Set(value().split(','))
    else throw new Error(`Unknown argument ${flag}. See scripts/listing-domain-check.ts.`)
  }
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(parsed.date)) throw new Error('--date must be YYYY-MM-DD.')
  if (parsed.command === 'dead-manifest' && !/^\d{4}-\d{2}-\d{2}$/u.test(parsed.since ?? ''))
    throw new Error('dead-manifest needs --since YYYY-MM-DD.')
  if (!Number.isInteger(parsed.concurrency) || parsed.concurrency < 1 || parsed.concurrency > 32)
    throw new Error('--concurrency must be 1 to 32.')
  return parsed
}

// v2 (#104 review): markup signals, longer redirect chains, and own-domain traces.
const cachePath = resolve('.runtime/listing-domains/observations-v2.ndjson')

/** Failed at a link shortener or affiliate hop, not at the product: our fetch, not the site. */
export function throttled(observation: SiteObservation): boolean {
  if (observation.result === 'page') return false
  const last = observation.hops.at(-1)
  if (!last) return true
  return isRedirectorHost(last.url) && isTransient(observation.result, observation.error)
}

/** The newest cached observation per listing id; one JSON line per check, appended as it ends. */
function readCache(): Map<string, SiteObservation & { id: string }> {
  const cache = new Map<string, SiteObservation & { id: string }>()
  if (!existsSync(cachePath)) return cache
  for (const line of readFileSync(cachePath, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line) as SiteObservation & { id: string }
      cache.set(entry.id, entry)
    } catch {
      // A line cut short by an interrupted run.
    }
  }
  return cache
}
const reportPathFor = (date: string) => `d1/hygiene/${date}-listing-domains.yaml`
export const recheckPathFor = (date: string) => `d1/hygiene/${date}-dead-domains.recheck.yaml`
export const decisionsPathFor = (date: string) => `d1/hygiene/${date}-owner-list-decisions.yaml`
export const adultDecisionsPathFor = (date: string) => `d1/hygiene/${date}-adult-decisions.yaml`
/** The manifests `adult-manifest` writes for a decisions date. */
export const adultManifestIds = (date: string) => ({
  categoryId: `${date}-adult-category`,
  removalId: `${date}-adult-removal`
})

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2))
  if (args.command === 'adult-manifest') {
    const decisionsPath = adultDecisionsPathFor(args.date)
    const ids = adultManifestIds(args.date)
    const manifests = buildAdultManifests(
      parse(readFileSync(resolve(decisionsPath), 'utf8')) as AdultDecisions,
      reviewedCatalogListings([ids.categoryId, ids.removalId]),
      { decisionsPath, ...ids }
    )
    for (const [id, source] of [
      [ids.categoryId, manifests.category],
      [ids.removalId, manifests.removal]
    ] as const) {
      if (!source) continue
      writeFileSync(resolve(`d1/publications/${id}.yaml`), source)
      console.log(`Wrote d1/publications/${id}.yaml`)
    }
    return
  }
  const report = readParityReport()
  const listings = reviewedImportListings()
  if (args.command === 'decisions-manifest') {
    const decisionsPath = decisionsPathFor(args.date)
    const id = `${args.date}-owner-list-cleanup`
    const manifest = buildDecisionsManifest(
      parse(readFileSync(resolve(decisionsPath), 'utf8')) as OwnerListDecisions,
      listings,
      { decisionsPath, id }
    )
    writeFileSync(resolve(`d1/publications/${id}.yaml`), manifest)
    console.log(`Wrote d1/publications/${id}.yaml`)
    return
  }
  if (args.command === 'dead-manifest') {
    const earlierPath = reportPathFor(args.since ?? '')
    const recheckPath = recheckPathFor(args.date)
    const read = (path: string) => parse(readFileSync(resolve(path), 'utf8')) as DomainReport
    const id = `${args.date}-dead-domains`
    const manifest = buildDeadDomainManifest(read(earlierPath), read(recheckPath), listings, {
      earlierPath,
      id,
      recheckPath
    })
    writeFileSync(resolve(`d1/publications/${id}.yaml`), manifest)
    console.log(`Wrote d1/publications/${id}.yaml`)
    return
  }
  if (args.command === 'manifest') {
    const reportPath = reportPathFor(args.date)
    const id = `${args.date}-hijacked-domains`
    const manifest = buildUnpublishManifest(
      parse(readFileSync(resolve(reportPath), 'utf8')) as DomainReport,
      listings,
      {
        id,
        reportPath
      }
    )
    writeFileSync(resolve(`d1/publications/${id}.yaml`), manifest)
    console.log(`Wrote d1/publications/${id}.yaml`)
    return
  }
  const selected = args.only ? listings.filter(listing => args.only?.has(listing.slug)) : listings
  const cache = args.reuse ? readCache() : new Map<string, SiteObservation & { id: string }>()
  mkdirSync(dirname(cachePath), { recursive: true })
  let done = 0
  const checked: CheckedEntry[] = await pool(selected, args.concurrency, async listing => {
    const cached = cache.get(listing.id)
    let observation: SiteObservation
    if (cached?.website === listing.website && !throttled(cached)) observation = cached
    else {
      observation = await traceWebsite(listing.website)
      appendFileSync(cachePath, `${JSON.stringify({ id: listing.id, ...observation })}\n`)
    }
    done += 1
    if (done % 100 === 0) console.error(`${done}/${selected.length}`)
    return { listing, observation }
  })
  // A link that never reached the listing's own domain says nothing about that domain: fetch it.
  await pool(checked, args.concurrency, async entry => {
    const url = ownDomainUrl(entry.listing, entry.observation)
    if (!url) return
    const key = `${entry.listing.id}#own`
    const cached = cache.get(key)
    if (cached?.website === url) entry.own = cached
    else {
      entry.own = await traceWebsite(url)
      appendFileSync(cachePath, `${JSON.stringify({ id: key, ...entry.own })}\n`)
    }
  })
  // The links pass through serp.ly, which rate-limits a fast scan. Check those again, slowly, so
  // our own throttling never reads as a dead listing.
  for (let pass = 1; pass <= 3; pass += 1) {
    const retry = checked.filter(entry => throttled(entry.observation))
    if (retry.length === 0) break
    console.error(`Pass ${pass}: ${retry.length} links throttled on the way; checking them slowly.`)
    await pool(retry, 2, async entry => {
      await new Promise(resolveWait => setTimeout(resolveWait, 1_000))
      entry.observation = await traceWebsite(entry.listing.website)
      appendFileSync(
        cachePath,
        `${JSON.stringify({ id: entry.listing.id, ...entry.observation })}\n`
      )
    })
  }
  const throttledLeft = checked.filter(entry => throttled(entry.observation)).length
  if (throttledLeft > 0)
    throw new Error(
      `${throttledLeft} links are still throttled at a redirector; rerun with --reuse later.`
    )
  const result = buildReport(
    checked,
    new Date().toISOString(),
    `reviewed import ${report.target.checksum.slice(0, 12)} (publication ${report.target.publicationVersion}), ${selected.length} live listings`
  )
  if (args.only) {
    console.log(renderReport(result))
    return
  }
  const reportPath = reportPathFor(args.date)
  mkdirSync(dirname(resolve(reportPath)), { recursive: true })
  writeFileSync(resolve(reportPath), renderReport(result))
  console.log(`Wrote ${reportPath}: ${JSON.stringify(result.counts)}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}

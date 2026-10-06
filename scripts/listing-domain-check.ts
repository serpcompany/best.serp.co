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
 *
 * Listings come from the reviewed import (`d1/artifacts`), the catalog both environments were
 * bootstrapped from. Each manifest operation carries the website it was checked against, so the
 * publisher refuses any listing that changed since (`listing-unpublish` `expected`).
 *
 * Options: --date YYYY-MM-DD, --concurrency N, --only slug[,slug], --base-version N,
 * --base-checksum <sha256>.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { parse, stringify } from 'yaml'
import { freshMigrationNames, freshMigrationsDirectory } from './d1-drizzle-local'
import { readParityReport, readReviewedImportSql } from './d1-import-artifact'
import { buildPublicationPlan, parseManifest } from './d1-publisher'
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

/** Live listings of the reviewed import, with their active categories in order. */
export function reviewedImportListings(): CatalogListing[] {
  const database = new DatabaseSync(':memory:')
  try {
    for (const migration of freshMigrationNames()) {
      database.exec(readFileSync(resolve(freshMigrationsDirectory, migration), 'utf8'))
    }
    database.exec(readReviewedImportSql(readParityReport()))
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
  baseChecksum: string
  baseVersion: number
  id: string
  reportPath: string
}

/** The publication manifest that unpublishes a report's `unpublish` list. */
export function buildUnpublishManifest(
  report: DomainReport,
  listings: readonly CatalogListing[],
  options: ManifestOptions
): string {
  const byId = new Map(listings.map(listing => [listing.id, listing]))
  const operations = report.unpublish.map(entry => {
    const listing = byId.get(entry.id)
    if (!listing || listing.slug !== entry.slug || listing.website !== entry.website)
      throw new Error(`${entry.slug} no longer matches the reviewed catalog; rerun the check.`)
    const label = entry.class === 'parking' ? 'parked or for sale' : 'gambling, betting, or spam'
    return {
      action: 'listing-unpublish',
      id: listing.id,
      slug: listing.slug,
      categories: listing.categories,
      reason: `#100 hijacked domain, ${label}: ${entry.marker ?? entry.reason}`.slice(0, 200),
      expected: { website: listing.website }
    }
  })
  if (operations.length === 0) throw new Error('The report lists nothing to unpublish.')
  const manifest = {
    version: 1,
    id: options.id,
    basePublicationVersion: options.baseVersion,
    provenance: {
      actor: 'devinschumacher',
      workflow: 'github/publish-d1',
      beforeChecksum: options.baseChecksum
    },
    operations
  }
  const header = `# serpcompany/best.serp.co#100: unpublish ${operations.length} listings whose domain is hijacked (gambling, betting,
# or spam), parked, or for sale, as the owner decided on 2026-10-06. Their pages answer 410 Gone and
# leave the sitemap, search, and RSS; the rows stay (Republish in /admin brings one back).
# Evidence: ${options.reportPath}.
# Generated by \`pnpm catalog:domains -- manifest\`. Each operation refuses a listing whose website
# or categories changed since. Apply staging first, then production after promotion.
`
  const source = `${header}${stringify(manifest, { lineWidth: 0 })}`
  // Refuse to write a manifest the publisher would not accept.
  buildPublicationPlan(parseManifest(source), source, new Date().toISOString())
  return source
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
  baseChecksum?: string
  baseVersion?: number
  command: 'manifest' | 'scan'
  concurrency: number
  date: string
  only: Set<string> | null
  reuse: boolean
}

export function parseArguments(argv: readonly string[]): Arguments {
  const args = argv.filter(value => value !== '--')
  const parsed: Arguments = {
    command: 'scan',
    concurrency: 8,
    date: new Date().toISOString().slice(0, 10),
    only: null,
    reuse: false
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
    else if (flag === '--reuse') parsed.reuse = true
    else if (flag === '--date') parsed.date = value()
    else if (flag === '--concurrency') parsed.concurrency = Number(value())
    else if (flag === '--only') parsed.only = new Set(value().split(','))
    else if (flag === '--base-version') parsed.baseVersion = Number(value())
    else if (flag === '--base-checksum') parsed.baseChecksum = value()
    else throw new Error(`Unknown argument ${flag}. See scripts/listing-domain-check.ts.`)
  }
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(parsed.date)) throw new Error('--date must be YYYY-MM-DD.')
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

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2))
  const report = readParityReport()
  const listings = reviewedImportListings()
  if (args.command === 'manifest') {
    const reportPath = reportPathFor(args.date)
    const id = `${args.date}-hijacked-domains`
    const manifest = buildUnpublishManifest(
      parse(readFileSync(resolve(reportPath), 'utf8')) as DomainReport,
      listings,
      {
        baseChecksum: args.baseChecksum ?? report.target.checksum,
        baseVersion: args.baseVersion ?? report.target.publicationVersion ?? 1,
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

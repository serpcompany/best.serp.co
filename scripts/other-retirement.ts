/**
 * Retiring the Other category (serpcompany/best.serp.co#351, step 10 of #341).
 *
 *   pnpm catalog:other-retirement -- inventory
 *       write d1/hygiene/2026-10-11-other-residue-inventory.json: every approved listing the
 *       committed manifests leave filed under Other, keeping the website checks already recorded
 *   pnpm catalog:other-retirement -- inventory --check
 *       the same, checking every live listing's website again first (read-only GETs)
 *   pnpm catalog:other-retirement
 *       write d1/publications/2026-10-11-other-retirement-*.yaml from the reviewed mapping
 *       d1/hygiene/2026-10-11-other-residue.yaml
 *
 * Its inputs are committed files only, never D1: the taxonomy generator's reviewed catalog
 * (`readReviewedInputs`: the two inventories with the 16 manifests published after them), then
 * the manifests published after those that it names (`otherRetirementInputManifests`: #349's 25
 * taxonomy manifests and #376's downloader links), replayed with each operation's `expected`
 * checked. A manifest committed later is never read, so what it generates stays fixed once
 * published. The inventory adds each listing's name and copy (#340's renames applied), #333's
 * proposal and flag, #340's audit verdict, the manifest that unpublished it, and, for live
 * listings, what its website showed (the listing domain check's fetcher and classifier).
 *
 * It writes three phases of row-level manifests (`concurrency: rows`), each planning at most
 * 2,000 statements, to publish in file order:
 *   1. `-01-removals`: `listing-unpublish` of the live listings the mapping retires (dead, not a
 *      product, spam, wrong copy, or a duplicate), and the redirect of /products/categories/other/
 *      to /products/ (`taxonomy-redirect-set` to the directory). Other's page renders over the
 *      redirect while it has a public listing, so it turns into a 308 when its last one leaves.
 *   2. `-02-move-NN`: every approved listing filed under Other, live or unpublished, goes under its
 *      hub alone (`listing-categories-set`), and a listing that stays live gets its tags
 *      (`listing-tags-set`, expecting none). Unpublished listings are re-filed too (design 1.5), so
 *      their 410 doesn't turn into a 404 when Other retires; the mapping names the few left there.
 *   3. `-03-retire`: the slug redirects of the retired duplicates to the listings they duplicate,
 *      then `category-unpublish other`, which refuses while a live listing or a slug redirect's
 *      source is still filed under it.
 */
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { reportEntry, throttled } from './listing-domain-check'
import { classifyListing, ownDomainUrl } from './listing-domain-classifier'
import { type SiteObservation, traceWebsite } from './listing-domain-fetch'
import {
  type BatchAssignments,
  type CatalogListing,
  manifestSource,
  moveStatements,
  packBatches,
  readReviewedInputs,
  taxonomyIds,
  taxonomyInputManifests,
  taxonomyPaths
} from './taxonomy-manifest'

// ---------------------------------------------------------------------------------------------
// The catalog the committed manifests leave.

/** A listing as the replay leaves it: its categories and tags in guard order. */
export interface ReplayedListing extends CatalogListing {
  tags: string[]
}

export interface ReplayedTag {
  slug: string
  hub: string
  active: boolean
}

export interface ReplayedCatalog {
  listings: Map<string, ReplayedListing>
  /** Category slug to whether it is active. */
  categories: Map<string, boolean>
  tags: Map<string, ReplayedTag>
  /** Taxonomy redirects by `<kind>:<slug>`, to `<kind>:<slug>` (or `directory`). */
  redirects: Map<string, string>
  /** Listings whose slug redirects to another listing (#338). */
  slugRedirectSources: Set<string>
}

type ReplayOperation = { action: string } & Record<string, unknown>

/** Operations that change no listing's categories, tags or live state, which the replay skips. */
const NEUTRAL_ACTIONS = new Set([
  'best-page-create',
  'best-page-listings-set',
  'listing-resources-set'
])

const same = (a: readonly string[], b: readonly string[]) => a.join('\0') === b.join('\0')
const redirectKey = (target: { kind: string; slug?: string }) =>
  target.kind === 'directory' ? 'directory' : `${target.kind}:${target.slug}`

/**
 * Applies the given manifests, in order, to the catalog, refusing an operation whose `expected`
 * disagrees or that it can't replay. A `category-unpublish` is refused, as the publisher refuses
 * it, while a live listing is still filed under the category.
 */
export function replayManifests(
  catalog: ReplayedCatalog,
  files: ReadonlyArray<{ name: string; source: string }>
): void {
  for (const { name, source } of files) {
    const manifest = parse(source) as { operations: ReplayOperation[] }
    for (const operation of manifest.operations) {
      const listing = catalog.listings.get(String(operation.id ?? ''))
      const where = `${name}: ${operation.action} ${String(operation.slug ?? '')}`
      const mismatch = () => new Error(`${where} does not match the replayed catalog.`)
      switch (operation.action) {
        case 'listing-categories-set':
          if (!listing || !same(listing.categories, operation.expected as string[]))
            throw mismatch()
          for (const slug of operation.categories as string[])
            if (catalog.categories.get(slug) !== true) throw mismatch()
          listing.categories = [...(operation.categories as string[])]
          break
        case 'listing-tags-set':
          if (!listing || !same(listing.tags, operation.expected as string[])) throw mismatch()
          for (const slug of operation.tags as string[])
            if (catalog.tags.get(slug)?.active !== true) throw mismatch()
          listing.tags = [...(operation.tags as string[])]
          break
        case 'listing-unpublish':
          if (!listing?.live || !same(listing.categories, operation.categories as string[]))
            throw mismatch()
          listing.live = false
          break
        case 'listing-slug-redirect':
          catalog.slugRedirectSources.add(String((operation.from as { id: string }).id))
          break
        case 'category-create': {
          const { slug } = operation.category as { slug: string }
          if (catalog.categories.has(slug)) throw mismatch()
          catalog.categories.set(slug, true)
          break
        }
        case 'category-unpublish': {
          const slug = String(operation.slug)
          if (catalog.categories.get(slug) !== true) throw mismatch()
          for (const entry of catalog.listings.values())
            if (
              entry.categories.includes(slug) &&
              (entry.live || catalog.slugRedirectSources.has(entry.id))
            )
              throw new Error(`${where}: ${entry.slug} is still filed under it.`)
          catalog.categories.set(slug, false)
          break
        }
        case 'tag-create': {
          const tag = operation.tag as { slug: string; category: string }
          if (catalog.tags.has(tag.slug) || catalog.categories.get(tag.category) !== true)
            throw mismatch()
          catalog.tags.set(tag.slug, { slug: tag.slug, hub: tag.category, active: true })
          break
        }
        case 'taxonomy-redirect-set': {
          const from = redirectKey(operation.from as { kind: string; slug: string })
          const expected = operation.expected as { kind: string; slug?: string } | null
          if ((catalog.redirects.get(from) ?? null) !== (expected && redirectKey(expected)))
            throw mismatch()
          catalog.redirects.set(from, redirectKey(operation.to as { kind: string; slug?: string }))
          break
        }
        default:
          if (!NEUTRAL_ACTIONS.has(operation.action))
            throw new Error(`${where}: the Other retirement does not replay ${operation.action}.`)
      }
    }
  }
}

/**
 * The manifests published after the taxonomy generator's inputs that this one applies, by file
 * name, in the owner's dispatch order (#341's staging publish record): #349's 25 taxonomy
 * manifests, then #376's downloader links (resource links only). Named, not discovered: a manifest
 * committed later changes nothing here.
 */
export const otherRetirementInputManifests: readonly string[] = (() => {
  const ids = taxonomyIds('2026-10-10')
  return [
    ids.create,
    ids.redirects,
    ...Array.from({ length: 22 }, (_, index) => ids.move(index + 1)),
    ids.retire,
    '2026-10-11-downloader-links'
  ].map(id => `${id}.yaml`)
})()

export const otherRetirementPaths = {
  ...taxonomyPaths,
  residueInventory: 'd1/hygiene/2026-10-11-other-residue-inventory.json',
  residue: 'd1/hygiene/2026-10-11-other-residue.yaml'
}

/** The catalog once every committed manifest it names is published (staging, 2026-10-11). */
export function readReplayedCatalog(paths = otherRetirementPaths): ReplayedCatalog {
  const { inputs } = readReviewedInputs(paths)
  const catalog: ReplayedCatalog = {
    listings: new Map(
      inputs.catalog.listings.map(listing => [
        listing.id,
        { ...listing, categories: [...listing.categories], tags: [] }
      ])
    ),
    categories: new Map(
      inputs.catalog.categories.map(category => [category.slug, category.active])
    ),
    tags: new Map(),
    redirects: new Map(),
    slugRedirectSources: new Set(inputs.catalog.slugRedirectSources)
  }
  replayManifests(
    catalog,
    otherRetirementInputManifests.map(name => ({
      name,
      source: readFileSync(resolve(paths.publications, name), 'utf8')
    }))
  )
  return catalog
}

// ---------------------------------------------------------------------------------------------
// The inventory.

/** What a live listing's website showed (the listing domain check's trace and classifier). */
export interface WebsiteCheck {
  checkedAt: string
  class: string
  finalUrl: string
  status: number | string
  title: string | null
  reason: string
  marker?: string
}

export interface ResidueListing {
  id: string
  slug: string
  name: string
  website: string
  description: string
  /** The long description as #333's inventory has it (live at its snapshot only). */
  content?: string
  live: boolean
  /** A slug redirect's source (#338): it must leave Other before Other retires. */
  slugRedirectSource?: true
  /** The committed manifest that unpublished it, when one did. */
  unpublishedBy?: string
  /** #333's proposal: why it stayed in Other, the cluster or held category, the flag. */
  proposal?: {
    reason?: string
    newCategory?: string
    held?: string
    flag?: string
    why?: string
  }
  /** #340's audit: verdict and the owner's decision. */
  audit?: { verdict: string; decision: string; category?: string; renameTo?: string }
  check?: WebsiteCheck
}

export interface ResidueInventory {
  issue: string
  generatedAt: string
  source: string[]
  fields: Record<string, string>
  counts: { listings: number; live: number; unpublished: number; slugRedirectSources: number }
  listings: ResidueListing[]
}

interface InventoryRow {
  id: string
  slug: string
  name: string
  website: string
  description: string
  content?: string
}

interface ProposalEntry {
  id: string
  slug: string
  reason?: string
  newCategory?: string
  held?: { primary?: string } | string
  flag?: string
  why?: string
}

interface AuditEntry {
  id: string
  verdict: string
  decision: string
  category?: string
  renameTo?: string
}

const read = <T>(path: string): T => JSON.parse(readFileSync(resolve(path), 'utf8')) as T
const readYaml = <T>(path: string): T => parse(readFileSync(resolve(path), 'utf8')) as T

/**
 * Every committed manifest the reviewed catalog is built from, in file order: those the inventories'
 * snapshot replayed (their "Manifests replayed" line), the taxonomy generator's inputs, and this
 * generator's. Named, not discovered, so a manifest committed later changes nothing.
 */
export function namedInputManifests(paths = otherRetirementPaths): string[] {
  const replayed = read<{ source: string[] }>(paths.inventory)
    .source.find(line => line.startsWith('Manifests replayed: '))
    ?.slice('Manifests replayed: '.length)
    .replace(/\.$/u, '')
    .split(', ')
  if (!replayed) throw new Error(`${paths.inventory} names no replayed manifests.`)
  return [...new Set([...replayed, ...taxonomyInputManifests, ...otherRetirementInputManifests])]
    .filter(name => name.endsWith('.yaml'))
    .sort()
}

function namedOperations(paths: typeof otherRetirementPaths) {
  return namedInputManifests(paths).flatMap(name =>
    readYaml<{ operations: ReplayOperation[] }>(`${paths.publications}/${name}`).operations.map(
      operation => ({ name, operation })
    )
  )
}

/** Each listing's name, description and website once #340's `listing-details-set`s apply. */
function listingCopy(paths: typeof otherRetirementPaths): Map<string, InventoryRow> {
  const rows = new Map<string, InventoryRow>()
  for (const row of [
    ...read<{ listings: InventoryRow[] }>(paths.otherInventory).listings,
    ...read<{ listings: InventoryRow[] }>(paths.inventory).listings
  ])
    rows.set(row.id, { ...row })
  for (const { operation } of namedOperations(paths)) {
    if (operation.action !== 'listing-details-set') continue
    const row = rows.get(String(operation.id))
    if (row) Object.assign(row, operation.details)
  }
  return rows
}

/** The first named manifest that unpublishes each listing, by id. */
function unpublishers(paths: typeof otherRetirementPaths): Map<string, string> {
  const found = new Map<string, string>()
  for (const { name, operation } of namedOperations(paths))
    if (operation.action === 'listing-unpublish' && !found.has(String(operation.id)))
      found.set(String(operation.id), name.replace(/\.yaml$/u, ''))
  return found
}

/**
 * Every approved listing the replayed catalog leaves filed under Other, in slug order, with what
 * the committed files say about it. `checks` are recorded website checks, kept by listing id.
 */
export function buildResidueInventory(
  catalog: ReplayedCatalog,
  paths = otherRetirementPaths,
  checks: ReadonlyMap<string, WebsiteCheck> = new Map()
): ResidueInventory {
  const copy = listingCopy(paths)
  const unpublishedBy = unpublishers(paths)
  const proposals = new Map(
    readYaml<{ listings: ProposalEntry[] }>(paths.proposals).listings.map(entry => [
      entry.id,
      entry
    ])
  )
  const audit = new Map(
    readYaml<{ listings: AuditEntry[] }>(paths.audit).listings.map(entry => [entry.id, entry])
  )
  const residue = [...catalog.listings.values()]
    .filter(listing => listing.categories.includes('other'))
    .sort((a, b) => (a.slug < b.slug ? -1 : 1))
  const listings = residue.map((listing): ResidueListing => {
    if (!same(listing.categories, ['other']))
      throw new Error(`${listing.slug} is filed under Other and ${listing.categories.join(', ')}.`)
    const row = copy.get(listing.id)
    if (!row) throw new Error(`${listing.slug} is in no inventory.`)
    const proposal = proposals.get(listing.id)
    const verdict = audit.get(listing.id)
    const held = typeof proposal?.held === 'string' ? proposal.held : proposal?.held?.primary
    const check = checks.get(listing.id)
    return {
      id: listing.id,
      slug: listing.slug,
      name: row.name,
      website: row.website,
      description: row.description,
      ...(row.content ? { content: row.content } : {}),
      live: listing.live,
      ...(catalog.slugRedirectSources.has(listing.id) ? { slugRedirectSource: true as const } : {}),
      ...(unpublishedBy.has(listing.id) ? { unpublishedBy: unpublishedBy.get(listing.id) } : {}),
      ...(proposal
        ? {
            proposal: {
              ...(proposal.reason ? { reason: proposal.reason } : {}),
              ...(proposal.newCategory ? { newCategory: proposal.newCategory } : {}),
              ...(held ? { held } : {}),
              ...(proposal.flag ? { flag: proposal.flag } : {}),
              ...(proposal.why ? { why: proposal.why } : {})
            }
          }
        : {}),
      ...(verdict
        ? {
            audit: {
              verdict: verdict.verdict,
              decision: verdict.decision,
              ...(verdict.category ? { category: verdict.category } : {}),
              ...(verdict.renameTo ? { renameTo: verdict.renameTo } : {})
            }
          }
        : {}),
      ...(listing.live && check ? { check } : {})
    }
  })
  const live = listings.filter(listing => listing.live).length
  return {
    issue: 'serpcompany/best.serp.co#351',
    generatedAt: '2026-10-11',
    source: [
      "The reviewed catalog as `pnpm catalog:taxonomy` reads it (d1/hygiene/2026-10-10-other-inventory.json and 2026-10-10-taxonomy-inventory.json, with the 16 manifests published after them), then the committed manifests published after those that `otherRetirementInputManifests` names (#349's 25 taxonomy manifests and #376's downloader links), replayed with each operation's `expected` checked: what staging holds after its 2026-10-11 publish, and production after its own publish of the same list.",
      'Every approved listing still filed under Other, live or unpublished. Each is filed under Other alone.',
      'Checked against staging D1 read-only on 2026-10-11 (the same ids, live states and categories). Not remote D1: each manifest operation guards its listing (`expected`), so a listing that changed refuses its batch.',
      "Generated by `pnpm catalog:other-retirement -- inventory` (scripts/other-retirement.ts); `--check` re-checks the live listings' websites."
    ],
    fields: {
      name: "The listing's name, description and website, #340's renames applied.",
      content:
        "The start of the long description as #333's inventory has it (listings live at its snapshot).",
      live: 'Approved and active (published), or approved and unpublished (410).',
      unpublishedBy:
        'The committed manifest that unpublished it; absent when none did (unpublished before the manifests, in the v1 import).',
      proposal:
        "#333's proposal (d1/hygiene/2026-10-10-other-categories.yaml): why it stayed in Other, its cluster (newCategory) or held category, and its owner flag.",
      audit:
        "#340's audit (d1/hygiene/2026-10-10-mismatch-audit.yaml): verdict, the owner's decision and the audit's category.",
      check:
        "Live listings only: where the website ended and how the listing domain check's classifier reads it (scripts/listing-domain-classifier.ts), from read-only GETs that follow redirects, meta refreshes and script redirects (scripts/listing-domain-fetch.ts), the listing's own domain fetched too when the link never reached it."
    },
    counts: {
      listings: listings.length,
      live,
      unpublished: listings.length - live,
      slugRedirectSources: listings.filter(listing => listing.slugRedirectSource).length
    },
    listings
  }
}

/** The website checks an inventory file records, by listing id. */
export function recordedChecks(
  path = otherRetirementPaths.residueInventory
): Map<string, WebsiteCheck> {
  if (!existsSync(resolve(path))) return new Map()
  return new Map(
    read<ResidueInventory>(path)
      .listings.filter(listing => listing.check)
      .map(listing => [listing.id, listing.check as WebsiteCheck])
  )
}

async function pool<T>(items: readonly T[], concurrency: number, work: (item: T) => Promise<void>) {
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next] as T
        next += 1
        await work(item)
      }
    })
  )
}

/** Checks each live listing's website as the listing domain check does (read-only GETs). */
export async function checkWebsites(
  listings: readonly ResidueListing[],
  checkedAt: string
): Promise<Map<string, WebsiteCheck>> {
  const results = new Map<string, WebsiteCheck>()
  const entries: Array<{
    listing: ResidueListing
    observation: SiteObservation
    own?: SiteObservation | null
  }> = []
  await pool(
    listings.filter(listing => listing.live),
    4,
    async listing => {
      entries.push({ listing, observation: await traceWebsite(listing.website) })
    }
  )
  for (let pass = 1; pass <= 3; pass += 1) {
    const retry = entries.filter(entry => throttled(entry.observation))
    if (retry.length === 0) break
    await pool(retry, 2, async entry => {
      await new Promise(done => setTimeout(done, 1_000))
      entry.observation = await traceWebsite(entry.listing.website)
    })
  }
  await pool(entries, 4, async entry => {
    const url = ownDomainUrl(entry.listing, entry.observation)
    if (url) entry.own = await traceWebsite(url)
  })
  for (const { listing, observation, own } of entries) {
    const classification = classifyListing(listing, observation, own)
    const report = reportEntry(listing, observation, classification, own)
    const seen = classification.source === 'own-domain' && own ? own : observation
    results.set(listing.id, {
      checkedAt,
      class: report.class,
      finalUrl: report.finalUrl,
      status: report.status,
      title: seen.page?.title?.slice(0, 120) ?? null,
      reason: report.reason,
      ...(report.marker ? { marker: report.marker } : {})
    })
  }
  return results
}

export const renderInventory = (inventory: ResidueInventory) =>
  `${JSON.stringify(inventory, null, 2)}\n`

// ---------------------------------------------------------------------------------------------
// The mapping, the plan and the manifests.

export const retireKinds = [
  'dead',
  'hijacked',
  'not-a-product',
  'spam',
  'wrong-copy',
  'duplicate'
] as const
export type RetireKind = (typeof retireKinds)[number]

/** Retirements that refuse a listing someone owns, claims or paid for (#332, #340 decision 2). */
const UNOWNED: ReadonlySet<RetireKind> = new Set(['wrong-copy', 'duplicate'])

export const RETIRE_REASONS: Record<RetireKind, (target?: string) => string> = {
  dead: () =>
    '#351 retire-dead (as #340 decision 1): the site is gone, parked, or no longer the product; evidence in d1/hygiene/2026-10-11-other-residue.yaml',
  hijacked: () =>
    '#351 retire-hijacked (as #340 decision 1): the domain now serves something unrelated; evidence in d1/hygiene/2026-10-11-other-residue.yaml',
  'not-a-product': () =>
    '#351 retire-not-a-product (as #340 decision 1): an article, research page, demo, art project, or publication; evidence in d1/hygiene/2026-10-11-other-residue.yaml',
  spam: () =>
    "#351 spam (as the owner's 2026-10-10 removal of traffic bots): it sells fake traffic or clicks; evidence in d1/hygiene/2026-10-11-other-residue.yaml",
  'wrong-copy': () =>
    "#351 keep-rewrite, retired instead of rewritten (as #340 decision 2): its copy doesn't describe the product; evidence in d1/hygiene/2026-10-11-other-residue.yaml",
  duplicate: target => `#351 duplicate of ${target} (as #332): one listing per product stays`
}

export interface MappingRef {
  slug: string
  id: string
}

export interface ResidueMappingListing extends MappingRef {
  hub: string
  tags?: string[]
  retire?: RetireKind
  duplicateOf?: MappingRef
  evidence: string
}

export interface ResidueMapping {
  decidedAt: string
  catchAll: string
  /** Where the catch-all's URL redirects once it retires: the directory, `/products/`. */
  redirect: { kind: 'directory' } | { kind: 'category' | 'tag' | 'best'; slug: string }
  /** Live listings per hub once every phase is published. */
  hubs?: Record<string, number>
  /** Live listings per tag this mapping adds to, once every phase is published. */
  tags?: Record<string, number>
  /** Every live listing filed under the catch-all. */
  listings: ResidueMappingListing[]
  /** Every unpublished listing filed under it, but those left there. */
  unpublished: Array<MappingRef & { hub: string; basis: string }>
  /** Unpublished listings left filed under it, which answer 404 once it retires. */
  leftInOther?: Array<MappingRef & { reason: string }>
}

export interface RetirementInputs {
  mapping: ResidueMapping
  catalog: ReplayedCatalog
  /** Each listing's website, by id: a row-level `listing-unpublish` expects it. */
  websites: ReadonlyMap<string, string>
  /** Listings whose own submission is in review: `listing-categories-set` refuses them. */
  inReview?: ReadonlySet<string>
}

/** One listing's `-02` change: its tags (live listings only) and its hub. */
export interface ResidueMove {
  id: string
  slug: string
  /** Live once the removals are published. */
  live: boolean
  expected: string[]
  expectedTags: string[]
  hub: string
  tags: string[]
}

export interface RetirementPlan {
  catchAll: string
  redirect: ResidueMapping['redirect']
  removals: Array<MappingRef & { website: string; categories: string[]; kind: RetireKind }>
  moves: ResidueMove[]
  slugRedirects: Array<{ from: MappingRef; to: MappingRef }>
  /** Live listings by primary category, and by tag, once every phase is published. */
  hubCounts: Map<string, number>
  tagCounts: Map<string, number>
}

/**
 * Checks the mapping against the catalog and works out every change. Throws, naming each problem,
 * when a listing filed under the catch-all is missing from the mapping or named twice, a hub or tag
 * is not active, a retirement or a duplicate is not what the catalog holds, a listing that must
 * change has its own submission in review, something would keep the catch-all from retiring, or a
 * declared count is not what the plan leaves.
 */
export function planOtherRetirement(inputs: RetirementInputs): RetirementPlan {
  const { mapping, catalog, websites } = inputs
  const inReview = inputs.inReview ?? new Set<string>()
  const problems: string[] = []
  const fail = (message: string) => problems.push(message)
  const catchAll = mapping.catchAll
  if (catalog.categories.get(catchAll) !== true) fail(`${catchAll} is not an active category`)
  const isHub = (slug: string) => slug !== catchAll && catalog.categories.get(slug) === true
  const { redirect } = mapping
  if (redirect.kind === 'category' && !isHub(redirect.slug))
    fail(`the redirect's target ${redirect.slug} is not an active hub`)
  if (redirect.kind === 'tag' && catalog.tags.get(redirect.slug)?.active !== true)
    fail(`the redirect's target ${redirect.slug} is not an active tag`)
  if (catalog.redirects.has(`category:${catchAll}`)) fail(`${catchAll} already redirects`)

  const residue = new Map(
    [...catalog.listings.values()]
      .filter(listing => listing.categories.includes(catchAll))
      .map(listing => [listing.id, listing])
  )
  const named = new Set<string>()
  const entry = (ref: MappingRef, label: string) => {
    const listing = residue.get(ref.id)
    if (named.has(ref.id)) fail(`${ref.slug} is named twice`)
    named.add(ref.id)
    if (!listing || listing.slug !== ref.slug) {
      fail(`${label} ${ref.slug} (${ref.id}) is not a listing filed under ${catchAll}`)
      return undefined
    }
    return listing
  }
  const checkHub = (ref: MappingRef, hub: string) => {
    if (!isHub(hub)) fail(`${ref.slug}: ${hub} is not an active hub`)
  }

  const removals: RetirementPlan['removals'] = []
  const moves: ResidueMove[] = []
  const slugRedirects: RetirementPlan['slugRedirects'] = []
  const retiringIds = new Set(
    mapping.listings.filter(item => item.retire !== undefined).map(item => item.id)
  )
  for (const item of mapping.listings) {
    const listing = entry(item, 'listing')
    if (!listing) continue
    if (!listing.live) fail(`${item.slug} is listed as live but is unpublished`)
    checkHub(item, item.hub)
    const tags = item.tags ?? []
    for (const tag of tags)
      if (catalog.tags.get(tag)?.active !== true) fail(`${item.slug}: ${tag} is not an active tag`)
    if (new Set(tags).size !== tags.length) fail(`${item.slug} names a tag twice`)
    if (inReview.has(item.id)) fail(`${item.slug}'s own submission is in review`)
    if (item.retire !== undefined) {
      if (!(retireKinds as readonly string[]).includes(item.retire))
        fail(`${item.slug}: ${item.retire} is not a kind of retirement`)
      if (tags.length > 0) fail(`${item.slug} retires, so it gets no tags`)
      const website = websites.get(item.id)
      if (!website) fail(`${item.slug} has no website to expect`)
      removals.push({
        id: item.id,
        slug: item.slug,
        website: website ?? '',
        categories: [...listing.categories],
        kind: item.retire
      })
      if (item.retire === 'duplicate') {
        const kept = item.duplicateOf ? catalog.listings.get(item.duplicateOf.id) : undefined
        if (!item.duplicateOf || !kept || kept.slug !== item.duplicateOf.slug)
          fail(`${item.slug} duplicates no listing of the catalog`)
        else if (!kept.live || residue.has(kept.id) || retiringIds.has(kept.id))
          fail(`${item.slug} duplicates ${kept.slug}, which is not a live listing that stays`)
        else if (catalog.slugRedirectSources.has(kept.id))
          fail(`${item.slug} duplicates ${kept.slug}, whose slug redirects itself`)
        else
          slugRedirects.push({
            from: { id: item.id, slug: item.slug },
            to: { id: kept.id, slug: kept.slug }
          })
      } else if (item.duplicateOf) fail(`${item.slug} names a duplicate but doesn't retire as one`)
    } else if (item.duplicateOf) fail(`${item.slug} names a duplicate but doesn't retire`)
    moves.push({
      id: item.id,
      slug: item.slug,
      live: item.retire === undefined,
      expected: [...listing.categories],
      expectedTags: [...listing.tags],
      hub: item.hub,
      tags: item.retire === undefined ? tags : []
    })
  }
  for (const item of mapping.unpublished) {
    const listing = entry(item, 'unpublished listing')
    if (!listing) continue
    if (listing.live) fail(`${item.slug} is listed as unpublished but is live`)
    checkHub(item, item.hub)
    if (inReview.has(item.id)) fail(`${item.slug}'s own submission is in review`)
    moves.push({
      id: item.id,
      slug: item.slug,
      live: false,
      expected: [...listing.categories],
      expectedTags: [...listing.tags],
      hub: item.hub,
      tags: []
    })
  }
  for (const item of mapping.leftInOther ?? []) {
    const listing = entry(item, 'listing left in Other')
    if (!listing) continue
    if (listing.live) fail(`${item.slug} is left in ${catchAll} but is live`)
    if (catalog.slugRedirectSources.has(item.id))
      fail(`${item.slug} is a slug redirect source, so ${catchAll} could never retire`)
  }
  for (const listing of residue.values())
    if (!named.has(listing.id)) fail(`${listing.slug} is filed under ${catchAll} but not mapped`)

  // What the plan leaves: live listings by primary category and by tag.
  const moved = new Map(moves.map(move => [move.id, move]))
  const hubCounts = new Map<string, number>()
  const tagCounts = new Map<string, number>()
  const bump = (counts: Map<string, number>, slug: string) =>
    counts.set(slug, (counts.get(slug) ?? 0) + 1)
  for (const listing of catalog.listings.values()) {
    const move = moved.get(listing.id)
    if (!(move ? move.live : listing.live)) continue
    const primary = move ? move.hub : listing.categories[0]
    if (primary) bump(hubCounts, primary)
    for (const tag of move && move.tags.length > 0 ? move.tags : listing.tags)
      if (catalog.tags.get(tag)?.active) bump(tagCounts, tag)
  }
  if ((hubCounts.get(catchAll) ?? 0) > 0) fail(`${catchAll} would keep a live listing`)
  for (const [hub, count] of Object.entries(mapping.hubs ?? {}))
    if ((hubCounts.get(hub) ?? 0) !== count)
      fail(`hub ${hub} would hold ${hubCounts.get(hub) ?? 0} listings, not ${count}`)
  for (const [tag, count] of Object.entries(mapping.tags ?? {}))
    if ((tagCounts.get(tag) ?? 0) !== count)
      fail(`tag ${tag} would carry ${tagCounts.get(tag) ?? 0} listings, not ${count}`)
  const added = new Set(moves.flatMap(move => move.tags))
  for (const tag of added)
    if (mapping.tags && !(tag in mapping.tags)) fail(`tag ${tag} gains listings but has no count`)

  if (problems.length > 0)
    throw new Error(
      `The Other retirement mapping does not fit the catalog:\n- ${problems.join('\n- ')}`
    )
  const bySlug = <T extends { slug: string }>(a: T, b: T) => (a.slug < b.slug ? -1 : 1)
  return {
    catchAll,
    redirect,
    removals: removals.sort(bySlug),
    moves: moves.sort(bySlug),
    slugRedirects: slugRedirects.sort((a, b) => bySlug(a.from, b.from)),
    hubCounts,
    tagCounts
  }
}

/** How many statements a listing's `-02` operations plan (`moveStatements` of the taxonomy). */
export const residueMoveStatements = (move: ResidueMove) => moveStatements(move)

export const otherRetirementIds = (date: string) => ({
  removals: `${date}-other-retirement-01-removals`,
  move: (batch: number) => `${date}-other-retirement-02-move-${String(batch).padStart(2, '0')}`,
  retire: `${date}-other-retirement-03-retire`
})

export const otherRetirementDefaults = { date: '2026-10-11' }

const phaseHeader = (lines: string[]) => `${lines.map(line => `# ${line}`).join('\n')}\n`
const generatedLines = [
  'Generated by `pnpm catalog:other-retirement` from d1/hygiene/2026-10-11-other-residue.yaml (the reviewed mapping).',
  'Row-level: an operation refuses its whole batch if its row changed since the reviewed catalog.'
]

/**
 * The manifests `[{ id, source }]`, in publish order. `-02` keeps each listing in the batch
 * `assignments` gives it; the rest, in slug order, fill new batches after the last assigned one.
 */
export function buildOtherRetirementManifests(
  plan: RetirementPlan,
  date: string,
  assignments: BatchAssignments = new Map()
): Array<{ id: string; source: string }> {
  const ids = otherRetirementIds(date)
  const out: Array<{ id: string; source: string }> = []
  const add = (id: string, header: string[], operations: readonly unknown[]) => {
    if (operations.length === 0) return
    out.push({
      id,
      source: manifestSource(phaseHeader([...header, ...generatedLines]), id, operations).source
    })
  }
  const kinds = retireKinds
    .map(kind => [kind, plan.removals.filter(removal => removal.kind === kind).length] as const)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${count} ${kind}`)
    .join(', ')
  add(
    ids.removals,
    [
      `serpcompany/best.serp.co#351 (#341 step 10, phase 1 of 3): unpublish ${plan.removals.length} live listings filed under ${plan.catchAll} (${kinds}),`,
      `then redirect /products/categories/${plan.catchAll}/ to ${plan.redirect.kind === 'directory' ? '/products/' : `${plan.redirect.kind} ${plan.redirect.slug}`}. Each reason names its kind; the evidence is in the mapping.`,
      'Hygiene removals come down even if someone owns or claimed the listing; a wrong-copy or duplicate one is',
      '`unowned` and refuses the batch instead (#332, #340 decision 2). Other renders over its redirect while it',
      'has a public listing, so its URL turns into a 308 when the last one moves. Publish first.'
    ],
    [
      ...plan.removals.map(removal => ({
        action: 'listing-unpublish',
        id: removal.id,
        slug: removal.slug,
        categories: removal.categories,
        reason: RETIRE_REASONS[removal.kind](
          plan.slugRedirects.find(redirect => redirect.from.id === removal.id)?.to.slug
        ),
        expected: {
          website: removal.website,
          ...(UNOWNED.has(removal.kind) ? { unowned: true } : {})
        }
      })),
      {
        action: 'taxonomy-redirect-set',
        from: { kind: 'category', slug: plan.catchAll },
        expected: null,
        to: plan.redirect
      }
    ]
  )
  const operationsOf = (move: ResidueMove) => [
    ...(move.tags.length > 0
      ? [
          {
            action: 'listing-tags-set',
            id: move.id,
            slug: move.slug,
            expected: move.expectedTags,
            tags: move.tags
          }
        ]
      : []),
    {
      action: 'listing-categories-set',
      id: move.id,
      slug: move.slug,
      expected: move.expected,
      categories: [move.hub]
    }
  ]
  for (const [batch, moves] of packBatches(plan.moves, residueMoveStatements, assignments)) {
    moves.sort((a, b) => (a.slug < b.slug ? -1 : 1))
    const live = moves.filter(move => move.live).length
    add(
      ids.move(batch),
      [
        `serpcompany/best.serp.co#351 (#341 step 10, phase 2 of 3): batch ${String(batch).padStart(2, '0')}, ${moves.length} listings filed under ${plan.catchAll}`,
        `(${moves[0]?.slug} to ${moves.at(-1)?.slug}), ${live} of them staying live. Each is filed under its hub alone`,
        '(listing-categories-set), and a live one gets its tags (listing-tags-set, expecting none). Unpublished',
        `listings are re-filed too, so their 410 stays a 410 when ${plan.catchAll} retires. Publish in order, after -01.`,
        'A listing keeps its batch when the manifests are regenerated.'
      ],
      moves.flatMap(operationsOf)
    )
  }
  add(
    ids.retire,
    [
      `serpcompany/best.serp.co#351 (#341 step 10, phase 3 of 3): send ${plan.slugRedirects.length} retired duplicates' slugs to the listings they`,
      `duplicate (#338), then retire ${plan.catchAll} (category-unpublish), which refuses while a live listing or a slug`,
      'redirect source is still filed under it. Publish last, after every -02 batch.'
    ],
    [
      ...plan.slugRedirects.map(redirect => ({
        action: 'listing-slug-redirect',
        from: redirect.from,
        to: redirect.to,
        reason: `#351 duplicate of ${redirect.to.slug}`
      })),
      { action: 'category-unpublish', slug: plan.catchAll }
    ]
  )
  return out
}

/**
 * The owner's read-only checks before publishing (docs/taxonomy-migration.md), each expecting no
 * rows: no listing's own submission in review and no owner revision open (the moves refuse the
 * first and give the listing a new checksum), no submission or revision in flight that names the
 * catch-all (it couldn't go live once the catch-all retires), and, before `-03-retire`, nothing
 * `category-unpublish` refuses: a live listing, or a slug redirect source, filed under it.
 */
export function retirementChecks(catchAll: string): {
  reviewQueue: string
  revisions: string
  inFlight: string
  retire: string
} {
  return {
    reviewQueue:
      "SELECT l.slug, s.status FROM listing_submissions s JOIN listings l ON l.id=s.listing_id WHERE s.status IN ('paid_pending_review','changes_requested') ORDER BY l.slug",
    revisions:
      "SELECT l.slug, r.status FROM listing_revisions r JOIN listings l ON l.id=r.listing_id WHERE r.status IN ('pending_review','changes_requested') ORDER BY l.slug",
    inFlight: `SELECT 'submission' AS kind, id, slug, status FROM listing_submissions WHERE category_slug='${catchAll}' AND status IN ('draft','pending_badge','verified','paid_pending_review','changes_requested') UNION ALL SELECT 'revision', r.id, l.slug, r.status FROM listing_revisions r JOIN listings l ON l.id=r.listing_id WHERE r.category_slug='${catchAll}' AND r.status IN ('pending_review','changes_requested') ORDER BY 1, 3`,
    retire: `SELECT l.slug, l.is_active FROM listing_categories lc JOIN categories c ON c.id=lc.category_id JOIN listings l ON l.id=lc.listing_id WHERE c.slug='${catchAll}' AND ((l.status='approved' AND l.is_active=1) OR EXISTS (SELECT 1 FROM listing_slug_redirects r WHERE r.old_slug=l.slug)) ORDER BY l.slug`
  }
}

/** The committed manifests this generator owns, by file name. */
export function committedRetirementManifests(
  directory = otherRetirementPaths.publications,
  date = otherRetirementDefaults.date
): string[] {
  return readdirSync(resolve(directory))
    .filter(name => name.startsWith(`${date}-other-retirement-`) && name.endsWith('.yaml'))
    .sort()
}

/** Each listing's `-02` batch in the committed manifests. */
export function committedRetirementAssignments(
  directory = otherRetirementPaths.publications,
  date = otherRetirementDefaults.date
): Map<string, number> {
  const assignments = new Map<string, number>()
  const prefix = `${date}-other-retirement-02-move-`
  for (const name of committedRetirementManifests(directory, date)) {
    if (!name.startsWith(prefix)) continue
    const batch = Number(name.slice(prefix.length, -'.yaml'.length))
    if (!Number.isSafeInteger(batch) || batch < 1) throw new Error(`${name} has no batch number.`)
    const manifest = readYaml<{ operations?: Array<{ id?: string }> }>(`${directory}/${name}`)
    for (const operation of manifest.operations ?? [])
      if (operation.id) assignments.set(operation.id, batch)
  }
  return assignments
}

/** The reviewed mapping, the replayed catalog and the websites the removals expect. */
export function readRetirementInputs(paths = otherRetirementPaths): RetirementInputs {
  const catalog = readReplayedCatalog(paths)
  const inventory = read<ResidueInventory>(paths.residueInventory)
  return {
    mapping: readYaml<ResidueMapping>(paths.residue),
    catalog,
    websites: new Map(inventory.listings.map(listing => [listing.id, listing.website]))
  }
}

export type RetirementCommand = { command: 'generate' } | { command: 'inventory'; check: boolean }

const USAGE =
  "Usage: pnpm catalog:other-retirement [-- inventory [--check]]. With no command it writes the manifests from the mapping; `inventory` rebuilds the inventory, keeping its recorded website checks, and `--check` checks the live listings' websites again first."

/**
 * The command line, parsed before anything is read or written (scripts/AGENTS.md): no command
 * writes the manifests, `inventory` the inventory, and `inventory --check` checks the websites
 * again first. Throws, with the usage, on any other command, flag or argument, so a mistyped
 * `--check` never rewrites the inventory with the old checks as if it had refreshed them.
 */
export function parseRetirementArgs(argv: readonly string[]): RetirementCommand {
  const [command, ...rest] = argv.filter(arg => arg !== '--')
  if (command === undefined) return { command: 'generate' }
  if (command === 'inventory') {
    if (rest.length > 1 || (rest.length === 1 && rest[0] !== '--check'))
      throw new Error(`Unexpected argument ${rest.at(-1)} for inventory. ${USAGE}`)
    return { command: 'inventory', check: rest.length === 1 }
  }
  throw new Error(`Unknown command ${command}. ${USAGE}`)
}

async function main(): Promise<void> {
  const args = parseRetirementArgs(process.argv.slice(2))
  if (args.command === 'inventory') {
    const catalog = readReplayedCatalog()
    const checks = args.check
      ? await checkWebsites(
          buildResidueInventory(catalog).listings,
          new Date().toISOString().slice(0, 10)
        )
      : recordedChecks()
    writeFileSync(
      resolve(otherRetirementPaths.residueInventory),
      renderInventory(buildResidueInventory(catalog, otherRetirementPaths, checks))
    )
    console.log(`Wrote ${otherRetirementPaths.residueInventory}`)
    return
  }
  const plan = planOtherRetirement(readRetirementInputs())
  const manifests = buildOtherRetirementManifests(
    plan,
    otherRetirementDefaults.date,
    committedRetirementAssignments()
  )
  for (const name of committedRetirementManifests())
    rmSync(resolve(otherRetirementPaths.publications, name))
  for (const { id, source } of manifests) {
    writeFileSync(resolve(otherRetirementPaths.publications, `${id}.yaml`), source)
    console.log(`Wrote ${otherRetirementPaths.publications}/${id}.yaml`)
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => {
    console.error(error)
    process.exitCode = 1
  })
}

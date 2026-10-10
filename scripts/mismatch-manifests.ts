/**
 * The owner's decisions on the listings whose copy doesn't describe their product
 * (serpcompany/best.serp.co#340).
 *
 *   pnpm catalog:mismatch
 *       write d1/publications/2026-10-10-mismatch-{removals,renames,categories}.yaml from the
 *       decisions recorded in d1/hygiene/2026-10-10-mismatch-audit.yaml
 *
 * Each audit entry carries a `decision` the owner made on 2026-10-10 (its verdict limits which):
 * - `retire` (a `retire-*` verdict): `listing-unpublish`, a hygiene removal, so not `unowned`, as
 *   the hijacked-domain, dead-domain, and adult manifests do: the listing comes down even if
 *   someone claimed it.
 * - `retire-instead-of-rewrite` (`keep-rewrite`): `listing-unpublish` with `expected.unowned`, as
 *   #332's duplicates: a real product someone owns, claims, or paid for refuses the batch instead.
 * - `retire-instead-of-rename` (`rename`): the same, for a renamed product whose long description
 *   still describes another product.
 * - `hold` (`retire-dead`): nothing yet; the site is rechecked first.
 * - `rename` and `fix-description` (`rename`, `keep-recategorize`): `listing-details-set` with the
 *   entry's `details`, and, when the entry's `category` is a live category, `listing-categories-set`
 *   out of Other. A proposed category no manifest has created leaves the listing in Other.
 *
 * Every operation expects the listing as the reviewed catalog's inventory
 * (d1/hygiene/2026-10-10-other-inventory.json) lists it: its categories (`[other]`), website, name,
 * and description. No manifest they are published after (`precedingManifests`) may change those
 * for these listings, or their `expected` would be stale (`committedListingChanges`); a later one
 * may. A held listing decided later goes into a new manifest id, never into these: once a manifest
 * succeeds on an environment, `publication_runs` refuses its id there. The manifests are row-level
 * (`concurrency: rows`): each operation refuses its whole batch if the listing changed since, so
 * one file applies on staging and production alike. It reads only committed files: no D1, and
 * nothing from `.archive/`.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse, stringify } from 'yaml'
import { buildPublicationPlan, parseManifest } from './d1-publisher'
import { committedOtherCategoryManifests } from './other-categories-manifest'

export const mismatchVerdicts = [
  'keep-recategorize',
  'keep-rewrite',
  'rename',
  'retire-dead',
  'retire-hijacked',
  'retire-not-a-product',
  'duplicate'
] as const
export type MismatchVerdict = (typeof mismatchVerdicts)[number]

export const mismatchDecisions = [
  'retire',
  'retire-instead-of-rewrite',
  'retire-instead-of-rename',
  'hold',
  'rename',
  'fix-description'
] as const
export type MismatchDecision = (typeof mismatchDecisions)[number]

/** Removals of real products: `expected.unowned`, so an owned or claimed listing refuses the batch. */
const unowned: ReadonlySet<MismatchDecision> = new Set([
  'retire-instead-of-rewrite',
  'retire-instead-of-rename'
])

/** The decisions the owner could make on each verdict. */
const decisionsByVerdict: Record<MismatchVerdict, readonly MismatchDecision[]> = {
  'keep-recategorize': ['fix-description'],
  'keep-rewrite': ['retire-instead-of-rewrite'],
  rename: ['rename', 'retire-instead-of-rename'],
  'retire-dead': ['retire', 'hold'],
  'retire-hijacked': ['retire'],
  'retire-not-a-product': ['retire'],
  duplicate: []
}

export interface ListingDetails {
  name?: string
  description?: string
  website?: string
}

/** One listing of the audit (`d1/hygiene/<date>-mismatch-audit.yaml`), with its decision. */
export interface MismatchEntry {
  slug: string
  id: string
  verdict: MismatchVerdict
  decision: MismatchDecision
  category?: string
  details?: ListingDetails
}

/** A listing of the reviewed catalog's inventory, as each operation expects it. */
export interface InventoryListing {
  id: string
  slug: string
  name: string
  description: string
  website: string
  categories: string[]
}

export const OTHER = 'other'

export const mismatchPaths = {
  audit: 'd1/hygiene/2026-10-10-mismatch-audit.yaml',
  inventory: 'd1/hygiene/2026-10-10-other-inventory.json',
  categories: 'd1/hygiene/2026-10-10-categories.json'
}

/** The manifests this generator writes, by kind. */
export const mismatchManifestIds = {
  removals: '2026-10-10-mismatch-removals',
  renames: '2026-10-10-mismatch-renames',
  categories: '2026-10-10-mismatch-categories'
} as const
export type MismatchManifestKind = keyof typeof mismatchManifestIds

/** The activity log's reason for each removal (at most 200 characters), by verdict. */
const removalReasons: Partial<Record<MismatchVerdict, string>> = {
  rename:
    '#340 rename, retired instead (owner decision 2026-10-10): its long description still describes another product; evidence in d1/hygiene/2026-10-10-mismatch-audit.yaml',
  'retire-dead':
    '#340 retire-dead (owner decision 2026-10-10): the site is down, parked, shut down, or no longer the product; evidence in d1/hygiene/2026-10-10-mismatch-audit.yaml',
  'retire-hijacked':
    '#340 retire-hijacked (owner decision 2026-10-10): the domain now serves gambling, spam, or an unrelated business; evidence in d1/hygiene/2026-10-10-mismatch-audit.yaml',
  'retire-not-a-product':
    '#340 retire-not-a-product (owner decision 2026-10-10): an article, publisher, or campaign page, not a product; evidence in d1/hygiene/2026-10-10-mismatch-audit.yaml',
  'keep-rewrite':
    "#340 keep-rewrite, retired instead of rewritten (owner decision 2026-10-10): its copy doesn't describe the product; evidence in d1/hygiene/2026-10-10-mismatch-audit.yaml"
}

/**
 * The committed manifests the #340 manifests are published after, by file name: #333's Other
 * batches and `other-removals`, #332's duplicates, and #338's slug redirects, all of 2026-10-10.
 * Every earlier manifest is already in the reviewed inventory. A later manifest is published after
 * these three, so it may change the same listings (#341 files the renames left in Other) without
 * making their `expected` stale; it is not read.
 */
export function precedingManifests(directory = 'd1/publications'): string[] {
  return [
    ...committedOtherCategoryManifests(directory),
    '2026-10-10-other-removals.yaml',
    '2026-10-10-duplicate-listings.yaml',
    '2026-10-10-duplicate-listings-redirects.yaml'
  ]
}

/**
 * The listings whose categories, live state, slug, or details a preceding manifest changes, by id
 * (the manifest's file name): #333's batches move them, #333's removals and #332's duplicates
 * unpublish them. A slug redirect's two listings count too (#338): unpublishing its target would
 * send its source back to 410. Media updates and claim holds change none of what these manifests
 * expect.
 */
export function committedListingChanges(
  directory = 'd1/publications',
  manifests: readonly string[] = precedingManifests(directory)
): Map<string, string> {
  const changing = new Set([
    'listing-create',
    'listing-update',
    'listing-unpublish',
    'listing-slug-change',
    'listing-categories-add',
    'listing-categories-remove',
    'listing-categories-set',
    'listing-details-set'
  ])
  const changes = new Map<string, string>()
  for (const name of manifests) {
    const manifest = parse(readFileSync(resolve(directory, name), 'utf8')) as {
      operations?: Array<{
        action?: string
        from?: { id?: string }
        id?: string
        listing?: { id?: string }
        to?: { id?: string }
      }>
    } | null
    // Each listing names the first manifest that changes it.
    const change = (id: string | undefined) => {
      if (id && !changes.has(id)) changes.set(id, name)
    }
    for (const operation of manifest?.operations ?? []) {
      if (operation.action && changing.has(operation.action))
        change(operation.id ?? operation.listing?.id)
      if (operation.action === 'listing-slug-redirect') {
        change(operation.from?.id)
        change(operation.to?.id)
      }
    }
  }
  return changes
}

/**
 * The operations of each manifest, in slug order. Refuses an audit that doesn't match the
 * inventory, a decision its verdict doesn't allow, details on a listing that isn't renamed or
 * fixed (or none on one that is), and a listing another committed manifest changes (`excluded`).
 */
export function mismatchOperations(
  entries: readonly MismatchEntry[],
  inventory: readonly InventoryListing[],
  liveCategories: ReadonlySet<string>,
  excluded: ReadonlyMap<string, string> = new Map()
) {
  const listings = new Map(inventory.map(listing => [listing.id, listing]))
  const seen = new Set<string>()
  const removals: Array<Record<string, unknown>> = []
  const renames: Array<Record<string, unknown>> = []
  const categories: Array<Record<string, unknown>> = []
  // Code-point order, the same on every machine (localeCompare depends on the locale).
  for (const entry of [...entries].sort((a, b) =>
    a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0
  )) {
    if (seen.has(entry.id) || seen.has(entry.slug))
      throw new Error(`${entry.slug} is in the audit twice.`)
    seen.add(entry.id).add(entry.slug)
    const listing = listings.get(entry.id)
    if (!listing || listing.slug !== entry.slug)
      throw new Error(`${entry.slug} (${entry.id}) is not in the inventory.`)
    if (listing.categories.join('\0') !== OTHER)
      throw new Error(
        `${entry.slug} is filed under ${listing.categories.join(', ')}, not Other alone.`
      )
    if (!(decisionsByVerdict[entry.verdict] ?? []).includes(entry.decision))
      throw new Error(`${entry.slug}: ${entry.verdict} can't be decided ${entry.decision}.`)
    const changed = excluded.get(entry.id)
    if (changed && entry.decision !== 'hold')
      throw new Error(`${entry.slug} is changed by ${changed}: leave it out.`)
    const details = entry.details
    const edits = entry.decision === 'rename' || entry.decision === 'fix-description'
    if (edits !== (details !== undefined))
      throw new Error(`${entry.slug}: only a rename or a description fix has details.`)
    if (entry.decision === 'retire' || unowned.has(entry.decision)) {
      removals.push({
        action: 'listing-unpublish',
        id: listing.id,
        slug: listing.slug,
        categories: listing.categories,
        reason: removalReasons[entry.verdict],
        expected: {
          website: listing.website,
          ...(unowned.has(entry.decision) ? { unowned: true } : {})
        }
      })
    }
    if (!details) continue
    if (entry.decision === 'rename' && (!details.name || details.name === listing.name))
      throw new Error(`${entry.slug}: a rename needs a new name.`)
    if (entry.decision === 'fix-description' && Object.keys(details).join() !== 'description')
      throw new Error(`${entry.slug}: a description fix changes only the description.`)
    renames.push({
      action: 'listing-details-set',
      id: listing.id,
      slug: listing.slug,
      reason:
        entry.decision === 'rename'
          ? `#340 rename (owner decision 2026-10-10): ${listing.name} is now ${details.name}`
          : '#340 keep-recategorize (owner decision 2026-10-10): the old one-line description was about another product',
      expected: {
        name: listing.name,
        description: listing.description,
        website: listing.website
      },
      details: {
        ...(details.name === undefined ? {} : { name: details.name }),
        ...(details.description === undefined ? {} : { description: details.description }),
        ...(details.website === undefined ? {} : { website: details.website })
      }
    })
    if (entry.category && liveCategories.has(entry.category))
      categories.push({
        action: 'listing-categories-set',
        id: listing.id,
        slug: listing.slug,
        expected: listing.categories,
        categories: [entry.category]
      })
  }
  return { removals, renames, categories }
}

const headers: Record<MismatchManifestKind, (count: number, held: readonly string[]) => string> = {
  removals: (
    count,
    held
  ) => `# serpcompany/best.serp.co#340: unpublish ${count} listings whose copy doesn't describe their product, as the
# owner decided in chat on 2026-10-10. Their pages answer 410 Gone and leave the sitemap, search,
# RSS, and the Other category page. The rows stay (Republish in /admin brings one back).
# - Owner decision 1, retire: the retire-dead, retire-hijacked, and retire-not-a-product verdicts,
#   except ${held.length} held for a recheck (the audit says why): ${held.join(', ')}.
#   A hygiene removal, so not \`unowned\`: the listing comes down even if someone owns or claimed
#   it, as the hijacked-domain, dead-domain, and adult manifests do.
# - Owner decision 2, retire instead of rewriting their copy: the keep-rewrite verdicts, real and
#   live products. Each is \`unowned\` (#332): a listing anyone owns, claims, paid for, or submitted
#   by publish time refuses the whole batch, rather than leaving those records on a retired row.
# - Owner decision 5, retire instead of renaming: the renames whose long description still describes
#   another product (an explainer, an article, terms or policies). \`unowned\`, as decision 2.
# Each operation's \`reason\` names its verdict; the evidence per listing is in
# d1/hygiene/2026-10-10-mismatch-audit.yaml.
`,
  renames:
    count => `# serpcompany/best.serp.co#340: correct ${count} listings whose name or one-line description doesn't match
# their product, as the owner decided in chat on 2026-10-10.
# - Owner decision 3, rename: the domain now hosts a renamed or successor product. The name and the
#   short description change, the description to a factual line written from the live site on
#   2026-10-10. The website changes only where the listing's link no longer reaches the product (the
#   page its serp.ly link points to is gone, 404, blocked, or fails TLS): the product's own URL.
# - Owner decision 4, faceapp.com: only its one-line description, which described Google Maps
#   imaging, changes.
# The long descriptions stay as they are: each renamed listing's already describes its new product
# (decision 5 retires the others). 2026-10-10-mismatch-categories moves the renamed listings whose
# audit category is live out of Other.
# Each listing-details-set compares and swaps the listing's slug, name, short description, and
# website, refuses a listing whose own submission is in review, and refuses a new website that
# another listing, a submission in flight, or a block already covers. It logs "Details edited".
`,
  categories:
    count => `# serpcompany/best.serp.co#340: move ${count} renamed listings out of Other to the category the audit
# gives them, as the owner decided in chat on 2026-10-10 (decision 3). listing-categories-set replaces
# each listing's [other] with that category as its primary. Renamed listings whose audit category is
# a proposed new one (d1/hygiene/2026-10-10-other-categories.yaml newCategories, which no manifest
# creates; the taxonomy work is #341) or that have none stay in Other, and so does faceapp.com.
`
}

const footer = `# Generated by \`pnpm catalog:mismatch\` from the audit's decisions. Every operation expects the
# listing as the reviewed inventory lists it (d1/hygiene/2026-10-10-other-inventory.json, the v1
# import's values; no committed manifest changes them), filed under [other] alone. None is in the
# 2026-10-10-other-categories batches (#333), 2026-10-10-other-removals,
# 2026-10-10-duplicate-listings (#332), or its slug redirects (#338). Row-level: a listing that
# changed since, or is no longer as expected, refuses the whole batch, with nothing written.
# Publish after #333's batches and 2026-10-10-other-removals, staging first, then production after
# promotion; the three #340 manifests apply in any order relative to each other.
`

/** A row-level manifest the publisher accepts (planned at any publication state), or an error. */
function manifestSource(
  kind: MismatchManifestKind,
  operations: ReadonlyArray<Record<string, unknown>>,
  held: readonly string[]
): string {
  const manifest = {
    version: 1,
    id: mismatchManifestIds[kind],
    concurrency: 'rows',
    provenance: { actor: 'devinschumacher', workflow: 'github/publish-d1' },
    operations
  }
  const source = `${headers[kind](operations.length, held)}${footer}${stringify(manifest, { lineWidth: 0 })}`
  buildPublicationPlan(parseManifest(source), source, new Date().toISOString(), {
    checksum: 'a'.repeat(64),
    version: 1
  })
  return source
}

/** The manifests `[{ id, source }]`, each with at least one operation. */
export function buildMismatchManifests(
  entries: readonly MismatchEntry[],
  inventory: readonly InventoryListing[],
  liveCategories: ReadonlySet<string>,
  excluded: ReadonlyMap<string, string> = new Map()
): Array<{ id: string; source: string }> {
  const operations = mismatchOperations(entries, inventory, liveCategories, excluded)
  const held = entries
    .filter(entry => entry.decision === 'hold')
    .map(entry => entry.slug)
    .sort()
  return (Object.keys(mismatchManifestIds) as MismatchManifestKind[])
    .filter(kind => operations[kind].length > 0)
    .map(kind => ({
      id: mismatchManifestIds[kind],
      source: manifestSource(kind, operations[kind], held)
    }))
}

/** The committed inputs: the audit's decisions, the inventory, and the live categories. */
export function readMismatchInputs(paths = mismatchPaths): {
  entries: MismatchEntry[]
  inventory: InventoryListing[]
  liveCategories: Set<string>
} {
  const entries = (
    parse(readFileSync(resolve(paths.audit), 'utf8')) as { listings?: MismatchEntry[] }
  ).listings
  if (!entries) throw new Error(`${paths.audit} has no listings.`)
  const inventory = (
    JSON.parse(readFileSync(resolve(paths.inventory), 'utf8')) as { listings: InventoryListing[] }
  ).listings
  const categories = (
    JSON.parse(readFileSync(resolve(paths.categories), 'utf8')) as {
      categories: Array<{ slug: string }>
    }
  ).categories
  return { entries, inventory, liveCategories: new Set(categories.map(row => row.slug)) }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const { entries, inventory, liveCategories } = readMismatchInputs()
  for (const { id, source } of buildMismatchManifests(
    entries,
    inventory,
    liveCategories,
    committedListingChanges()
  )) {
    writeFileSync(resolve('d1/publications', `${id}.yaml`), source)
    console.log(`Wrote d1/publications/${id}.yaml`)
  }
}

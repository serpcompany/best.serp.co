/**
 * Listings filed only under Other move to real categories (serpcompany/best.serp.co#333).
 *
 *   pnpm catalog:other-categories
 *       write d1/publications/2026-10-10-other-categories-NN.yaml from the reviewed proposal
 *       d1/hygiene/2026-10-10-other-categories.yaml
 *
 * Every proposal whose `primary` is a live category gets one `listing-categories-set` operation:
 * `expected` is the listing's categories in the reviewed catalog
 * (d1/hygiene/2026-10-10-other-inventory.json, always `[other]`), and `categories` its primary
 * then its secondaries, so it leaves Other. A proposal that stays in Other gets none. The
 * manifests are row-level (`concurrency: rows`): each operation refuses its whole batch if the
 * listing's slug or categories changed since, so one file applies on staging and production
 * alike. It reads only committed files: no D1, and nothing from `.archive/`.
 *
 * Batch membership is fixed: a listing stays in the batch its committed manifest gives it, and work
 * no committed batch holds goes to new batches after the last one. Regenerating after a change
 * rewrites only the batches whose listings changed, never shifting a listing into another batch,
 * so a batch an environment already applied keeps its meaning (#342 review). Delete the committed
 * batches to re-slice only while none of them is published anywhere.
 */
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse, stringify } from 'yaml'
import { buildPublicationPlan, parseManifest } from './d1-publisher'

/** A listing's category proposal, as `d1/hygiene/<date>-other-categories.yaml` lists it. */
export interface CategoryProposal {
  slug: string
  id: string
  primary: string
  secondary?: string[]
}

/** A listing of the reviewed catalog's inventory, with its categories in the guard's order. */
export interface InventoryListing {
  id: string
  slug: string
  categories: string[]
}

export interface OtherCategoryOptions {
  /** Manifest ids are `<date>-other-categories-NN`. */
  date: string
  batchSize: number
  proposalsPath: string
  inventoryPath: string
}

/** The category every proposal's listing is filed under alone in the reviewed catalog. */
export const OTHER = 'other'

export const otherCategoryPaths = {
  proposals: 'd1/hygiene/2026-10-10-other-categories.yaml',
  inventory: 'd1/hygiene/2026-10-10-other-inventory.json',
  categories: 'd1/hygiene/2026-10-10-categories.json'
}

/** The defaults the committed manifests were generated with. */
export const otherCategoryDefaults: OtherCategoryOptions = {
  date: '2026-10-10',
  // About 11 statements per operation: 180 keeps every batch at or below 2,000 statements, below
  // the largest batch ever published (legacy-media-06, 2,129).
  batchSize: 180,
  proposalsPath: otherCategoryPaths.proposals,
  inventoryPath: otherCategoryPaths.inventory
}

/**
 * One `listing-categories-set` per proposal with a live primary category, in inventory (slug)
 * order. Refuses a proposal set that doesn't cover the inventory exactly once, a listing whose id,
 * slug, or categories don't match it, and a category that isn't live.
 */
export function categorySetOperations(
  proposals: readonly CategoryProposal[],
  inventory: readonly InventoryListing[],
  liveCategories: ReadonlySet<string>
) {
  const bySlug = new Map(proposals.map(proposal => [proposal.slug, proposal]))
  if (bySlug.size !== proposals.length) throw new Error('A listing is proposed twice.')
  const listed = new Set(inventory.map(listing => listing.slug))
  for (const proposal of proposals)
    if (!listed.has(proposal.slug))
      throw new Error(`${proposal.slug} is not in the inventory: propose only inventory listings.`)
  return inventory.flatMap(listing => {
    const proposal = bySlug.get(listing.slug)
    if (!proposal) throw new Error(`${listing.slug} has no proposal: every listing needs one.`)
    if (proposal.id !== listing.id)
      throw new Error(`${listing.slug}: proposal id ${proposal.id} is not ${listing.id}.`)
    if (proposal.primary === OTHER) return []
    if (listing.categories.join('\0') !== OTHER)
      throw new Error(
        `${listing.slug} is filed under ${listing.categories.join(', ')}, not Other alone.`
      )
    const categories = [proposal.primary, ...(proposal.secondary ?? [])]
    if (new Set(categories).size !== categories.length)
      throw new Error(`${listing.slug} names a category twice.`)
    for (const slug of categories) {
      if (slug === OTHER)
        throw new Error(`${listing.slug}: Other is never a secondary of a listing leaving it.`)
      if (!liveCategories.has(slug))
        throw new Error(`${listing.slug}: ${slug} is not a live category.`)
    }
    return [
      {
        action: 'listing-categories-set',
        id: listing.id,
        slug: listing.slug,
        expected: listing.categories,
        categories
      }
    ]
  })
}

type Operation = ReturnType<typeof categorySetOperations>[number]

/** A batch's header names only the batch itself, so adding a batch never rewrites the others. */
function header(
  operations: readonly Operation[],
  batch: string,
  options: OtherCategoryOptions
): string {
  const first = operations[0]?.slug
  const last = operations.at(-1)?.slug
  return `# serpcompany/best.serp.co#333: move ${operations.length} listings filed only under Other to real categories (batch ${batch},
# ${first} to ${last}), as ${options.proposalsPath} proposes, pending the owner.
# listing-categories-set replaces each listing's [other] with its primary category and secondaries,
# so it leaves Other. Listings proposed for a new category, held for an owner flag, or left out
# stay in Other.
# Generated by \`pnpm catalog:other-categories\`. Row-level: an operation refuses its whole batch if
# the listing's slug or categories changed since the reviewed catalog, or a category is missing or
# retired. Publish the batches in order, staging first, then production after promotion. A listing
# keeps its batch when the manifests are regenerated.
`
}

/** A row-level manifest the publisher accepts (planned at any publication state), or an error. */
function manifestSource(prefix: string, id: string, operations: readonly Operation[]): string {
  const manifest = {
    version: 1,
    id,
    concurrency: 'rows',
    provenance: { actor: 'devinschumacher', workflow: 'github/publish-d1' },
    operations
  }
  const source = `${prefix}${stringify(manifest, { lineWidth: 0 })}`
  buildPublicationPlan(parseManifest(source), source, new Date().toISOString(), {
    checksum: 'a'.repeat(64),
    version: 1
  })
  return source
}

/** The batch number of each listing (by id) in committed manifests: what keeps membership fixed. */
export type BatchAssignments = ReadonlyMap<string, number>

const batchId = (date: string, batch: number) =>
  `${date}-other-categories-${String(batch).padStart(2, '0')}`

/**
 * The manifests `[{ id, source }]`: every operation in the batch `assignments` gives its listing,
 * then the rest in slug order in new batches of `batchSize` after the last assigned one. Within a
 * batch, operations are in slug order. A batch left with no operation is not written.
 */
export function buildOtherCategoryManifests(
  proposals: readonly CategoryProposal[],
  inventory: readonly InventoryListing[],
  liveCategories: ReadonlySet<string>,
  options: OtherCategoryOptions,
  assignments: BatchAssignments = new Map()
): Array<{ id: string; source: string }> {
  if (!Number.isSafeInteger(options.batchSize) || options.batchSize < 1)
    throw new Error('The batch size must be a positive integer.')
  const operations = categorySetOperations(proposals, inventory, liveCategories)
  if (operations.length === 0) throw new Error('No proposal moves a listing out of Other.')
  const batches = new Map<number, Operation[]>()
  const unassigned: Operation[] = []
  for (const operation of operations) {
    const batch = assignments.get(operation.id)
    if (batch === undefined) unassigned.push(operation)
    else batches.set(batch, [...(batches.get(batch) ?? []), operation])
  }
  let next = Math.max(0, ...assignments.values()) + 1
  for (let start = 0; start < unassigned.length; start += options.batchSize)
    batches.set(next++, unassigned.slice(start, start + options.batchSize))
  if (Math.max(...batches.keys()) > 99)
    throw new Error('More than 99 batches: raise the batch size.')
  return [...batches]
    .sort(([a], [b]) => a - b)
    .map(([batch, batchOperations]) => {
      const id = batchId(options.date, batch)
      const label = String(batch).padStart(2, '0')
      return {
        id,
        source: manifestSource(header(batchOperations, label, options), id, batchOperations)
      }
    })
}

/** Each listing's batch in the committed manifests (`<date>-other-categories-NN.yaml`). */
export function committedBatchAssignments(
  directory = 'd1/publications',
  date = otherCategoryDefaults.date
): Map<string, number> {
  const assignments = new Map<string, number>()
  for (const name of committedOtherCategoryManifests(directory, date)) {
    const batch = Number(name.slice(`${date}-other-categories-`.length, -'.yaml'.length))
    if (!Number.isSafeInteger(batch) || batch < 1) throw new Error(`${name} has no batch number.`)
    const manifest = parse(readFileSync(resolve(directory, name), 'utf8')) as {
      operations?: Array<{ id?: string }>
    }
    for (const operation of manifest.operations ?? [])
      if (operation.id) assignments.set(operation.id, batch)
  }
  return assignments
}

/** The committed inputs: proposals, the reviewed catalog's inventory, and its live categories. */
export function readOtherCategoryInputs(paths = otherCategoryPaths): {
  proposals: CategoryProposal[]
  inventory: InventoryListing[]
  liveCategories: Set<string>
} {
  const proposals = (
    parse(readFileSync(resolve(paths.proposals), 'utf8')) as {
      listings?: CategoryProposal[]
    }
  ).listings
  if (!proposals) throw new Error(`${paths.proposals} has no listings.`)
  const inventory = (
    JSON.parse(readFileSync(resolve(paths.inventory), 'utf8')) as { listings: InventoryListing[] }
  ).listings
  const categories = (
    JSON.parse(readFileSync(resolve(paths.categories), 'utf8')) as {
      categories: Array<{ slug: string }>
    }
  ).categories
  return { proposals, inventory, liveCategories: new Set(categories.map(row => row.slug)) }
}

/** The committed manifests this generator owns, by file name. */
export function committedOtherCategoryManifests(
  directory = 'd1/publications',
  date = otherCategoryDefaults.date
): string[] {
  return readdirSync(resolve(directory))
    .filter(name => name.startsWith(`${date}-other-categories-`) && name.endsWith('.yaml'))
    .sort()
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const { proposals, inventory, liveCategories } = readOtherCategoryInputs()
  const manifests = buildOtherCategoryManifests(
    proposals,
    inventory,
    liveCategories,
    otherCategoryDefaults,
    committedBatchAssignments()
  )
  for (const name of committedOtherCategoryManifests()) rmSync(resolve('d1/publications', name))
  for (const { id, source } of manifests) {
    writeFileSync(resolve('d1/publications', `${id}.yaml`), source)
    console.log(`Wrote d1/publications/${id}.yaml`)
  }
}

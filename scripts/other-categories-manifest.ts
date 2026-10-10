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
  batchSize: 200,
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

function header(
  operations: readonly Operation[],
  batch: number,
  batches: number,
  options: OtherCategoryOptions
): string {
  const first = operations[0]?.slug
  const last = operations.at(-1)?.slug
  return `# serpcompany/best.serp.co#333: move ${operations.length} listings filed only under Other to real categories (batch ${batch} of
# ${batches}, ${first} to ${last}), as ${options.proposalsPath} proposes, pending the owner.
# listing-categories-set replaces each listing's [other] with its primary category and secondaries,
# so it leaves Other. Listings proposed for a new category, held for an owner flag, or left out
# stay in Other.
# Generated by \`pnpm catalog:other-categories\`. Row-level: an operation refuses its whole batch if
# the listing's slug or categories changed since the reviewed catalog, or a category is missing or
# retired. Publish the batches in order, staging first, then production after promotion.
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

/** The manifests, in batches of `batchSize` operations in slug order: `[{ id, source }]`. */
export function buildOtherCategoryManifests(
  proposals: readonly CategoryProposal[],
  inventory: readonly InventoryListing[],
  liveCategories: ReadonlySet<string>,
  options: OtherCategoryOptions
): Array<{ id: string; source: string }> {
  if (!Number.isSafeInteger(options.batchSize) || options.batchSize < 1)
    throw new Error('The batch size must be a positive integer.')
  const operations = categorySetOperations(proposals, inventory, liveCategories)
  if (operations.length === 0) throw new Error('No proposal moves a listing out of Other.')
  const batches: Operation[][] = []
  for (let start = 0; start < operations.length; start += options.batchSize)
    batches.push(operations.slice(start, start + options.batchSize))
  if (batches.length > 99) throw new Error('More than 99 batches: raise the batch size.')
  return batches.map((batch, index) => {
    const id = `${options.date}-other-categories-${String(index + 1).padStart(2, '0')}`
    return {
      id,
      source: manifestSource(header(batch, index + 1, batches.length, options), id, batch)
    }
  })
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
    otherCategoryDefaults
  )
  for (const name of committedOtherCategoryManifests()) rmSync(resolve('d1/publications', name))
  for (const { id, source } of manifests) {
    writeFileSync(resolve('d1/publications', `${id}.yaml`), source)
    console.log(`Wrote d1/publications/${id}.yaml`)
  }
}

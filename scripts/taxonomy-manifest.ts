/**
 * The three-layer taxonomy's migration (serpcompany/best.serp.co#349, step 7 of #341).
 *
 *   pnpm catalog:taxonomy
 *       write d1/publications/2026-10-10-taxonomy-*.yaml from the reviewed mapping
 *       d1/hygiene/2026-10-10-taxonomy.yaml
 *
 * Its inputs are committed files only, never D1 and nothing from `.archive/`: the mapping; the
 * reviewed catalog's inventories (2026-10-10-other-inventory.json for the listings filed only under
 * Other, 2026-10-10-taxonomy-inventory.json for every other approved listing), with the 16 committed
 * manifests published after that snapshot applied on top (`taxonomyInputManifests`: #332, #333,
 * #338, #340); #333's proposal for the Other listings' clusters; and #340's audit for the renamed
 * ones. A manifest committed later is never read, so the generator's output stays fixed once the
 * owner publishes it (as `mismatch-manifests.ts` names its preceding manifests).
 *
 * It writes three phases of row-level manifests (`concurrency: rows`), each planning at most
 * 2,000 statements, to publish in file order:
 *   1. create (`-01a-create`, `-01b-redirects`): the new hub categories, the tags, and the best
 *      pages with their pins and exclusions; then the redirects of every old category URL and of
 *      every tag a tag-only best page takes over. The hubs, tags and redirects are inert until
 *      listings move (a page renders over its redirect while it has listings, design 2.2), but the
 *      best pages go live at `-01a`: their pins count toward their pool, so each renders its 10
 *      entries at once, with links to tags and hubs that stay empty until phase 2. Publish `-01b`
 *      and every phase-2 batch straight after it.
 *   2. move listings (`-02-move-NN`): `listing-tags-set` (expected none) and
 *      `listing-categories-set` (expected the listing's categories, set to its hub alone).
 *   3. retire (`-03-retire`): `category-unpublish` of every narrow category, which refuses while a
 *      live listing or a slug redirect's source is still filed under it.
 *
 * Batch membership is fixed, as #333's is (#342 review): a listing stays in the phase-2 batch its
 * committed manifest gives it, and a listing no committed batch holds goes to a new batch after the
 * last. Regenerating rewrites only the batches whose listings changed, so a batch an environment
 * already applied keeps its meaning. Delete the committed batches to re-slice only while none of
 * them is published anywhere.
 */
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse, stringify } from 'yaml'
import { buildPublicationPlan, parseManifest } from './d1-publisher'

/** The most statements one manifest may plan (#342 review: below legacy-media-06's 2,129). */
export const STATEMENT_CEILING = 2000
/**
 * Statements every manifest plans besides its operations: the base check and the run row before
 * them, the version bump, its check, and the run's outcome after.
 */
const MANIFEST_OVERHEAD = 5
/** The list size of every best page (design 7.7, the publisher's default). */
export const BEST_PAGE_LIST_SIZE = 10
/** Each best page's pins: the top of its list (design 1.3). */
export const BEST_PAGE_PINS = 10
/** An intro's length in words (design 5.1). */
export const INTRO_WORDS = { min: 60, max: 150 } as const

export interface TaxonomyTarget {
  kind: 'best' | 'category' | 'tag'
  slug: string
}

export interface MappingHub {
  slug: string
  /** A category that exists already and stays as a hub (`video-downloaders`). */
  existing?: boolean
  name?: string
  order?: number
  /** Live listings whose primary category it is once every phase is published. */
  listings?: number
}

export interface MappingTag {
  slug: string
  hub: string
  name: string
  /** A #333 cluster: a new slug. Otherwise the tag keeps the narrow category with its slug. */
  cluster?: boolean
  /** Narrow categories whose listings and URL this tag takes over. */
  merges?: string[]
  /** Live listings that carry the tag once every phase is published. */
  listings?: number
}

export interface MappingListingRef {
  slug: string
  id: string
}

export interface MappingBestPage {
  slug: string
  keyword: string
  /** Ahrefs US search volume of the keyword when checked. */
  volume: number | null
  tag?: string
  category?: string
  /** The keyword's plural when it isn't the keyword plus "s" (a mass noun): the title's basis. */
  plural?: string
  title?: string
  heading?: string
  intro: string
  pins: Array<MappingListingRef & { evidence: string }>
  passedOver?: Array<{ slug: string; reason: string }>
  exclude?: Array<MappingListingRef & { reason: string }>
}

export interface MappingRedirect {
  from: TaxonomyTarget
  to: TaxonomyTarget
}

export interface TaxonomyMapping {
  decidedAt: string
  /** The catch-all category, which stays (step 10 retires it), or none. */
  catchAll?: string
  keywordsCheckedAt: string | null
  hubs: MappingHub[]
  other?: { listings?: number }
  tags: MappingTag[]
  bestPages: MappingBestPage[]
  redirects: MappingRedirect[]
  /** Clustered catch-all listings left in it while the owner's flag on them stands. */
  held?: Array<MappingListingRef & { flag: string }>
  /**
   * Listings that name one feature, add-on, model or sub-tool of a larger site: its traffic
   * measures the parent product, so they are never pinned, on any page.
   */
  featureListings?: Array<MappingListingRef & { name: string; reason: string }>
}

/** An approved listing as the catalog files it: categories in the publisher's guard order. */
export interface CatalogListing {
  id: string
  slug: string
  live: boolean
  categories: string[]
}

export interface CatalogCategory {
  slug: string
  name: string
  description: string
  active: boolean
}

export interface TaxonomyCatalog {
  listings: CatalogListing[]
  categories: CatalogCategory[]
  /** Listings whose own submission is in review: `listing-categories-set` refuses them. */
  inReview?: ReadonlySet<string>
  /**
   * Listings whose slug redirects to another listing (`listing_slug_redirects`, #338).
   * `category-unpublish` refuses while one is filed under the category, so each must move, and
   * it gets no tags: its page redirects.
   */
  slugRedirectSources?: ReadonlySet<string>
}

export interface TaxonomyInputs {
  mapping: TaxonomyMapping
  catalog: TaxonomyCatalog
  /** Catch-all listings' tags, the cluster first: they move to that tag's hub. */
  clusters?: ReadonlyMap<string, string[]>
  /** Listings re-filed under their hub without tags (retired by another manifest). */
  untagged?: ReadonlySet<string>
}

/** One listing's phase-2 change. */
export interface ListingMove {
  id: string
  slug: string
  live: boolean
  expected: string[]
  hub: string
  tags: string[]
}

export interface TaxonomyPlan {
  newHubs: Array<{ slug: string; name: string; description: string; order: number }>
  tags: Array<{ slug: string; name: string; description: string; hub: string }>
  bestPages: Array<{
    slug: string
    keyword: string
    title: string
    heading: string
    intro: string
    tag: string | null
    category: string | null
    keywordVolume: number | null
    pins: MappingListingRef[]
    exclude: MappingListingRef[]
  }>
  redirects: MappingRedirect[]
  moves: ListingMove[]
  retiring: string[]
  /** Live listings by primary category, and by tag, once every phase is published. */
  hubCounts: Map<string, number>
  tagCounts: Map<string, number>
}

/** The categories' own description template, which new hubs and cluster tags follow. */
export const describe = (name: string): string =>
  `Browse ${name.toLowerCase()} listings and resources.`

const ACRONYMS: Record<string, string> = {
  ai: 'AI',
  gpu: 'GPU',
  hipaa: 'HIPAA',
  pdf: 'PDF',
  seo: 'SEO'
}
const SMALL_WORDS = new Set(['a', 'and', 'for', 'in', 'of', 'the', 'to'])

/** A count noun's plural: "ai photo editor" is "ai photo editors". */
export function pluralize(phrase: string): string {
  if (/s$/u.test(phrase)) return phrase
  if (/[^aeiou]y$/u.test(phrase)) return `${phrase.slice(0, -1)}ies`
  return `${phrase}s`
}

/** Title case, acronyms in capitals and short words lower: "AI Tools for Teachers". */
export function titleCase(phrase: string): string {
  return phrase
    .split(/\s+/u)
    .filter(Boolean)
    .map((word, index) => {
      const acronym = ACRONYMS[word.toLowerCase()]
      if (acronym) return acronym
      if (index > 0 && SMALL_WORDS.has(word.toLowerCase())) return word.toLowerCase()
      return `${word.charAt(0).toUpperCase()}${word.slice(1)}`
    })
    .join(' ')
}

/** A best page's default title and H1 (design 5.1): "Best {keyword, plural, title case}". */
export const defaultBestTitle = (keyword: string, plural?: string): string =>
  `Best ${titleCase(plural ?? pluralize(keyword))}`

const countWords = (text: string): number => text.split(/\s+/u).filter(Boolean).length
const same = (a: readonly string[], b: readonly string[]) => a.join('\0') === b.join('\0')
const key = (target: TaxonomyTarget) => `${target.kind}\0${target.slug}`

/**
 * Checks the mapping against the catalog and works out every change. Throws, naming each problem,
 * when the mapping leaves a narrow category unmapped, a redirect aimed at a retiring category, an
 * empty page, or a chain, when a pin is not a live listing of its page's pool, when a listing that
 * must move has its own submission in review, or when a declared count is not what the migration
 * leaves.
 */
export function planTaxonomy(inputs: TaxonomyInputs): TaxonomyPlan {
  const { mapping, catalog } = inputs
  const clusters = inputs.clusters ?? new Map<string, string[]>()
  const untagged = inputs.untagged ?? new Set<string>()
  const inReview = catalog.inReview ?? new Set<string>()
  const redirectSources = catalog.slugRedirectSources ?? new Set<string>()
  const problems: string[] = []
  const fail = (message: string) => problems.push(message)
  const categories = new Map(catalog.categories.map(category => [category.slug, category]))
  const activeCategory = (slug: string) => categories.get(slug)?.active === true

  // Hubs: the new ones are new slugs; the kept ones, and the catch-all, are active categories.
  const hubs = new Map<string, MappingHub>()
  for (const hub of mapping.hubs) {
    if (hubs.has(hub.slug)) fail(`hub ${hub.slug} is listed twice`)
    hubs.set(hub.slug, hub)
    if (hub.existing) {
      if (!activeCategory(hub.slug)) fail(`hub ${hub.slug} is not an active category`)
    } else {
      if (categories.has(hub.slug)) fail(`hub ${hub.slug} is already a category`)
      if (!hub.name || hub.order === undefined) fail(`hub ${hub.slug} needs a name and an order`)
    }
  }
  const catchAll = mapping.catchAll
  if (catchAll !== undefined) {
    if (!activeCategory(catchAll)) fail(`the catch-all ${catchAll} is not an active category`)
    if (hubs.has(catchAll)) fail(`the catch-all ${catchAll} is not one of the hubs`)
  }
  const kept = new Set([...hubs.keys(), ...(catchAll === undefined ? [] : [catchAll])])
  const retiring = catalog.categories
    .filter(category => category.active && !kept.has(category.slug))
    .map(category => category.slug)
    .sort()
  const retiringSet = new Set(retiring)

  // Tags: one per narrow category, which keeps its slug, or a merge into a neighbour; plus clusters.
  const tags = new Map<string, MappingTag>()
  const tagOf = new Map<string, string>()
  for (const tag of mapping.tags) {
    if (tags.has(tag.slug)) fail(`tag ${tag.slug} is listed twice`)
    tags.set(tag.slug, tag)
    const hub = hubs.get(tag.hub)
    if (!hub) fail(`tag ${tag.slug}: its hub ${tag.hub} is not one of the hubs`)
    if (tag.cluster) {
      if (categories.has(tag.slug)) fail(`cluster tag ${tag.slug} is a category's slug`)
    } else if (!retiringSet.has(tag.slug)) {
      fail(`tag ${tag.slug} is neither a cluster nor a narrow category`)
    } else {
      tagOf.set(tag.slug, tag.slug)
    }
    for (const merged of tag.merges ?? []) {
      if (!retiringSet.has(merged)) fail(`tag ${tag.slug} merges ${merged}, not a narrow category`)
      else if (tagOf.has(merged)) fail(`${merged} merges into two tags`)
      else tagOf.set(merged, tag.slug)
    }
  }
  for (const slug of retiring) if (!tagOf.has(slug)) fail(`narrow category ${slug} has no tag`)
  const hubOfTag = (tag: string) => tags.get(tag)?.hub ?? ''

  // Listings: every approved listing filed under a narrow category moves to its hub; a live
  // catch-all listing with a cluster moves to the cluster's hub.
  const moves: ListingMove[] = []
  const notMoved: CatalogListing[] = []
  const blocked: string[] = []
  const listingsById = new Map(catalog.listings.map(listing => [listing.id, listing]))
  for (const id of clusters.keys())
    if (!listingsById.has(id)) fail(`clustered listing ${id} is not in the catalog`)
  for (const listing of [...catalog.listings].sort((a, b) => (a.slug < b.slug ? -1 : 1))) {
    const cluster = clusters.get(listing.id) ?? []
    for (const tag of cluster)
      if (!tags.has(tag)) fail(`${listing.slug}: cluster tag ${tag} is not a tag`)
    const narrow = listing.categories.filter(slug => retiringSet.has(slug))
    // Filed under a retired category (Adult): it answers 404 and stays as it is.
    if (listing.categories.some(slug => !activeCategory(slug))) {
      if (cluster.length > 0)
        fail(`${listing.slug} is clustered but filed under a retired category`)
      // It can't be re-filed (a retired category can't be set), so a redirect from it would keep
      // its narrow categories from retiring.
      if (narrow.length > 0 && redirectSources.has(listing.id))
        fail(
          `${listing.slug} is a slug redirect source filed under ${narrow.join(', ')} and a retired category, so they could never retire`
        )
      notMoved.push(listing)
      continue
    }
    const [primary = ''] = listing.categories
    let hub: string
    let listingTags: string[]
    if (narrow.length > 0) {
      hub = retiringSet.has(primary) ? hubOfTag(tagOf.get(primary) ?? '') : primary
      listingTags = [...narrow.map(slug => tagOf.get(slug) ?? ''), ...cluster]
    } else if (cluster.length > 0) {
      if (!listing.live || !same(listing.categories, [catchAll ?? ''])) {
        fail(`${listing.slug} is clustered but not live in ${catchAll} alone`)
        continue
      }
      hub = hubOfTag(cluster[0] ?? '')
      listingTags = cluster
    } else {
      notMoved.push(listing)
      continue
    }
    if (inReview.has(listing.id)) blocked.push(listing.slug)
    moves.push({
      id: listing.id,
      slug: listing.slug,
      live: listing.live,
      expected: listing.categories,
      hub,
      // A redirect source's page redirects, and another manifest's retirement keeps its tags off.
      tags:
        untagged.has(listing.id) || redirectSources.has(listing.id) ? [] : [...new Set(listingTags)]
    })
  }
  if (blocked.length > 0)
    fail(
      `their own submissions are in review, so listing-categories-set would refuse them; clear the review queue first: ${blocked.join(', ')}`
    )

  // What the migration leaves: live listings by primary category and by tag.
  const hubCounts = new Map<string, number>()
  const tagCounts = new Map<string, number>([...tags.keys()].map(slug => [slug, 0]))
  const bump = (counts: Map<string, number>, slug: string) =>
    counts.set(slug, (counts.get(slug) ?? 0) + 1)
  for (const move of moves) {
    if (!move.live) continue
    bump(hubCounts, move.hub)
    for (const tag of move.tags) bump(tagCounts, tag)
  }
  for (const listing of notMoved)
    if (listing.live && listing.categories[0]) bump(hubCounts, listing.categories[0])
  const members = (tag: string) => tagCounts.get(tag) ?? 0
  const pool = (page: MappingBestPage) => {
    const ids = new Set<string>()
    for (const move of moves)
      if (
        move.live &&
        (page.tag === undefined || move.tags.includes(page.tag)) &&
        (page.category === undefined || move.hub === page.category)
      )
        ids.add(move.id)
    if (page.tag === undefined)
      for (const listing of notMoved)
        if (listing.live && listing.categories[0] === page.category) ids.add(listing.id)
    return ids
  }
  for (const hub of mapping.hubs)
    if (hub.listings !== undefined && (hubCounts.get(hub.slug) ?? 0) !== hub.listings)
      fail(
        `hub ${hub.slug} would hold ${hubCounts.get(hub.slug) ?? 0} listings, not ${hub.listings}`
      )
  for (const hub of mapping.hubs)
    if ((hubCounts.get(hub.slug) ?? 0) === 0) fail(`hub ${hub.slug} would be empty`)
  const otherCount = catchAll === undefined ? 0 : (hubCounts.get(catchAll) ?? 0)
  if (mapping.other?.listings !== undefined && otherCount !== mapping.other.listings)
    fail(`${catchAll} would hold ${otherCount} listings, not ${mapping.other.listings}`)
  for (const tag of mapping.tags)
    if (tag.listings !== undefined && members(tag.slug) !== tag.listings)
      fail(`tag ${tag.slug} would carry ${members(tag.slug)} listings, not ${tag.listings}`)

  // Best pages: on an active tag, a hub, or both, with pins and exclusions from their pool.
  const bestPages = new Map<string, MappingBestPage>()
  const tagOnly = new Map<string, string>()
  for (const page of mapping.bestPages) {
    const label = `best page ${page.slug}`
    if (bestPages.has(page.slug)) fail(`${label} is listed twice`)
    bestPages.set(page.slug, page)
    if (page.tag === undefined && page.category === undefined) fail(`${label} has no pool`)
    if (page.tag !== undefined && !tags.has(page.tag)) fail(`${label}: ${page.tag} is not a tag`)
    if (page.category !== undefined && !hubs.has(page.category))
      fail(`${label}: ${page.category} is not a hub`)
    if (page.tag !== undefined && page.category === undefined) {
      if (tagOnly.has(page.tag)) fail(`${label}: two tag-only best pages use ${page.tag}`)
      tagOnly.set(page.tag, page.slug)
    }
    const words = countWords(page.intro)
    if (words < INTRO_WORDS.min || words > INTRO_WORDS.max)
      fail(`${label}: its intro has ${words} words, not ${INTRO_WORDS.min} to ${INTRO_WORDS.max}`)
    const inPool = pool(page)
    const excluded = new Set((page.exclude ?? []).map(entry => entry.id))
    // The top of the list is pinned: 10, or the whole pool when it is smaller.
    const pinned = Math.min(BEST_PAGE_PINS, inPool.size - excluded.size)
    if (page.pins.length !== pinned)
      fail(`${label} pins ${page.pins.length} listings, not ${pinned}`)
    const named = new Set<string>()
    for (const entry of [...page.pins, ...(page.exclude ?? [])]) {
      const listing = listingsById.get(entry.id)
      if (named.has(entry.id)) fail(`${label} names ${entry.slug} twice`)
      named.add(entry.id)
      if (!listing || listing.slug !== entry.slug)
        fail(`${label}: ${entry.slug} (${entry.id}) is not a listing of the catalog`)
      else if (!inPool.has(entry.id))
        fail(`${label}: ${entry.slug} is not a live listing of its pool`)
    }
    if (inPool.size - excluded.size < 1) fail(`${label} would list nothing`)
  }

  // A feature of a larger site is ranked by nothing its host's traffic says: never a pin.
  const features = new Set((mapping.featureListings ?? []).map(entry => entry.id))
  for (const entry of mapping.featureListings ?? [])
    if (listingsById.get(entry.id)?.slug !== entry.slug)
      fail(`feature listing ${entry.slug} is not a listing of the catalog`)
  for (const page of mapping.bestPages)
    for (const pin of page.pins)
      if (features.has(pin.id))
        fail(`best page ${page.slug} pins ${pin.slug}, a feature of a larger site`)

  // Redirects: one from every narrow category, and one from every tag a tag-only best page uses,
  // each to a hub, a tag or a best page with something to show, never to another redirect.
  const sources = new Map<string, TaxonomyTarget>()
  for (const redirect of mapping.redirects) {
    const label = `redirect ${redirect.from.kind} ${redirect.from.slug}`
    if (sources.has(key(redirect.from))) fail(`${label} is listed twice`)
    sources.set(key(redirect.from), redirect.to)
    if (redirect.from.kind === 'category' && !retiringSet.has(redirect.from.slug))
      fail(`${label}: only a narrow category's URL redirects`)
    if (redirect.from.kind === 'tag' && !tagOnly.has(redirect.from.slug))
      fail(`${label}: only a tag a tag-only best page uses redirects`)
    if (redirect.from.kind === 'best') fail(`${label}: no best page retires here`)
  }
  for (const redirect of mapping.redirects) {
    const label = `redirect ${redirect.from.kind} ${redirect.from.slug}`
    const { to } = redirect
    if (sources.has(key(to))) fail(`${label} ends at ${to.kind} ${to.slug}, which redirects too`)
    if (to.kind === 'category') {
      if (retiringSet.has(to.slug)) fail(`${label} aims at ${to.slug}, a retiring category`)
      else if (!hubs.has(to.slug)) fail(`${label}: ${to.slug} is not a hub`)
    } else if (to.kind === 'tag') {
      if (!tags.has(to.slug)) fail(`${label}: ${to.slug} is not a tag`)
      else if (members(to.slug) === 0) fail(`${label} aims at ${to.slug}, a tag with no listing`)
      else if (tagOnly.has(to.slug))
        fail(`${label} aims at ${to.slug}; aim it at /best/${tagOnly.get(to.slug)}/`)
    } else if (!bestPages.has(to.slug)) fail(`${label}: ${to.slug} is not a best page`)
    if (
      redirect.from.kind === 'tag' &&
      !(to.kind === 'best' && to.slug === tagOnly.get(redirect.from.slug))
    )
      fail(`${label} must go to /best/${tagOnly.get(redirect.from.slug)}/`)
  }
  for (const slug of retiring)
    if (!sources.has(key({ kind: 'category', slug })))
      fail(`narrow category ${slug} has no redirect`)
  for (const tag of tagOnly.keys())
    if (!sources.has(key({ kind: 'tag', slug: tag })))
      fail(`tag ${tag} has no redirect to its best page`)

  // Held catch-all listings must still be live there, and unclustered.
  for (const held of mapping.held ?? []) {
    const listing = listingsById.get(held.id)
    if (!listing || listing.slug !== held.slug) fail(`held ${held.slug} is not a listing`)
    else if (clusters.has(held.id)) fail(`held ${held.slug} is clustered too`)
  }

  if (problems.length > 0)
    throw new Error(`The taxonomy mapping does not fit the catalog:\n- ${problems.join('\n- ')}`)

  return {
    newHubs: mapping.hubs
      .filter(hub => !hub.existing)
      .map(hub => ({
        slug: hub.slug,
        name: hub.name ?? '',
        description: describe(hub.name ?? ''),
        order: hub.order ?? 0
      })),
    tags: mapping.tags.map(tag => ({
      slug: tag.slug,
      name: tag.name,
      // A tag that keeps a narrow category keeps its description; a cluster gets the template.
      description: tag.cluster
        ? describe(tag.name)
        : (categories.get(tag.slug)?.description ?? describe(tag.name)),
      hub: tag.hub
    })),
    bestPages: mapping.bestPages.map(page => {
      const title = page.title ?? defaultBestTitle(page.keyword, page.plural)
      return {
        slug: page.slug,
        keyword: page.keyword,
        title,
        heading: page.heading ?? title,
        intro: page.intro,
        tag: page.tag ?? null,
        category: page.category ?? null,
        keywordVolume: page.volume,
        pins: page.pins.map(({ id, slug }) => ({ id, slug })),
        exclude: (page.exclude ?? []).map(({ id, slug }) => ({ id, slug }))
      }
    }),
    redirects: mapping.redirects,
    moves,
    retiring,
    hubCounts,
    tagCounts
  }
}

/** How many statements a listing's phase-2 operations plan (`d1-publisher.ts`). */
export function moveStatements(move: ListingMove): number {
  // listing-tags-set: two guards, the delete, an insert and its check per tag, the update, the
  // event. listing-categories-set: two guards, the draft and its check, the delete, an insert and
  // its check for the hub, the approval and its check, the event.
  return (move.tags.length > 0 ? 5 + 2 * move.tags.length : 0) + 10
}

export interface TaxonomyOptions {
  /** Manifest ids are `<date>-taxonomy-*`. */
  date: string
  keywordsCheckedAt: string | null
}

const provenance = { actor: 'devinschumacher', workflow: 'github/publish-d1' }

/** A row-level manifest the publisher accepts, planned to check it, with its statement count. */
function manifestSource(
  prefix: string,
  id: string,
  operations: readonly unknown[]
): { source: string; statements: number } {
  const manifest = { version: 1, id, concurrency: 'rows', provenance, operations }
  const source = `${prefix}${stringify(manifest, { lineWidth: 0 })}`
  const plan = buildPublicationPlan(parseManifest(source), source, '2026-10-10T00:00:00.000Z', {
    checksum: 'a'.repeat(64),
    version: 1
  })
  if (plan.statements.length > STATEMENT_CEILING)
    throw new Error(`${id} plans ${plan.statements.length} statements, over ${STATEMENT_CEILING}.`)
  return { source, statements: plan.statements.length }
}

const phaseHeader = (lines: string[]) => `${lines.map(line => `# ${line}`).join('\n')}\n`
const generated = [
  'Generated by `pnpm catalog:taxonomy` from d1/hygiene/2026-10-10-taxonomy.yaml (the owner-approved mapping).',
  'Row-level: an operation refuses its whole batch if its row changed since the reviewed catalog.'
]

export const taxonomyIds = (date: string) => ({
  create: `${date}-taxonomy-01a-create`,
  redirects: `${date}-taxonomy-01b-redirects`,
  move: (batch: number) => `${date}-taxonomy-02-move-${String(batch).padStart(2, '0')}`,
  retire: `${date}-taxonomy-03-retire`
})

/** The phase-2 batch of each listing (by id) in committed manifests: fixed membership. */
export type BatchAssignments = ReadonlyMap<string, number>

/**
 * The manifests `[{ id, source }]`, in publish order. Phase 2 keeps each listing in the batch
 * `assignments` gives it; the rest, in slug order, fill new batches up to the statement ceiling
 * after the last assigned one. Within a batch, listings are in slug order.
 */
export function buildTaxonomyManifests(
  plan: TaxonomyPlan,
  options: TaxonomyOptions,
  assignments: BatchAssignments = new Map()
): Array<{ id: string; source: string }> {
  const ids = taxonomyIds(options.date)
  const out: Array<{ id: string; source: string }> = []
  const add = (id: string, header: string[], operations: readonly unknown[]) => {
    if (operations.length === 0) return
    out.push({
      id,
      source: manifestSource(phaseHeader([...header, ...generated]), id, operations).source
    })
  }

  add(
    ids.create,
    [
      `serpcompany/best.serp.co#349 (#341 phase 1 of 3, create): ${plan.newHubs.length} hub categories, ${plan.tags.length} tags under their hubs,`,
      `then ${plan.bestPages.length} best pages at /best/<keyword>/, each with its pins (positions 1 to 10) and exclusions.`,
      'The hubs and tags answer 404 until listings move, but the best pages go live here: their pins count toward',
      'their pool, so each renders its 10 entries at once, with links to tags and hubs that stay empty until',
      'phase 2. Publish first, then -01b and every -02 batch straight after. The evidence for each keyword and',
      'pin is in the mapping.'
    ],
    [
      ...plan.newHubs.map(hub => ({
        action: 'category-create',
        category: {
          slug: hub.slug,
          name: hub.name,
          description: hub.description,
          order: hub.order
        }
      })),
      ...plan.tags.map(tag => ({
        action: 'tag-create',
        tag: {
          slug: tag.slug,
          name: tag.name,
          description: tag.description,
          category: tag.hub,
          order: 0
        }
      })),
      ...plan.bestPages.flatMap(page => [
        {
          action: 'best-page-create',
          page: {
            slug: page.slug,
            keyword: page.keyword,
            title: page.title,
            heading: page.heading,
            intro: page.intro,
            tag: page.tag,
            category: page.category,
            listSize: BEST_PAGE_LIST_SIZE,
            keywordVolume: page.keywordVolume,
            keywordCheckedAt: page.keywordVolume === null ? null : options.keywordsCheckedAt,
            order: 0
          }
        },
        {
          action: 'best-page-listings-set',
          slug: page.slug,
          expected: { pins: [], exclude: [] },
          pins: page.pins,
          exclude: page.exclude
        }
      ])
    ]
  )

  add(
    ids.redirects,
    [
      `serpcompany/best.serp.co#349 (#341 phase 1 of 3, create): ${plan.redirects.length} redirects, one from every narrow category's URL`,
      'and one from every tag a tag-only best page takes over. A page renders over its redirect while it has',
      'listings, so each old URL turns into a 308 the moment its last listing moves (design 2.2).',
      'Publish after -01a, before any -02 batch.'
    ],
    plan.redirects.map(redirect => ({
      action: 'taxonomy-redirect-set',
      from: redirect.from,
      expected: null,
      to: redirect.to
    }))
  )

  // Phase 2: fixed batches, then new ones packed up to the ceiling.
  const operationsOf = (move: ListingMove) => [
    ...(move.tags.length > 0
      ? [
          {
            action: 'listing-tags-set',
            id: move.id,
            slug: move.slug,
            expected: [],
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
  const batches = new Map<number, ListingMove[]>()
  const unassigned: ListingMove[] = []
  for (const move of plan.moves) {
    const batch = assignments.get(move.id)
    if (batch === undefined) unassigned.push(move)
    else batches.set(batch, [...(batches.get(batch) ?? []), move])
  }
  // As few new batches as the ceiling allows, evened out: a batch closes once the listings so far
  // reach its share of the total, or the next one would pass the ceiling.
  let next = Math.max(0, ...assignments.values()) + 1
  const total = unassigned.reduce((sum, move) => sum + moveStatements(move), 0)
  // Room for one listing that doesn't fit: a batch rarely ends exactly at the ceiling.
  const largest = Math.max(0, ...unassigned.map(moveStatements))
  const count = Math.ceil(total / (STATEMENT_CEILING - MANIFEST_OVERHEAD - largest))
  let current: ListingMove[] = []
  let size = MANIFEST_OVERHEAD
  let done = 0
  let closed = 0
  for (const move of unassigned) {
    const statements = moveStatements(move)
    if (
      current.length > 0 &&
      (size + statements > STATEMENT_CEILING || done >= ((closed + 1) * total) / count)
    ) {
      batches.set(next++, current)
      closed += 1
      current = []
      size = MANIFEST_OVERHEAD
    }
    current.push(move)
    size += statements
    done += statements
  }
  if (current.length > 0) batches.set(next++, current)
  if (Math.max(0, ...batches.keys()) > 99) throw new Error('More than 99 phase-2 batches.')
  for (const [batch, moves] of [...batches].sort(([a], [b]) => a - b)) {
    moves.sort((a, b) => (a.slug < b.slug ? -1 : 1))
    add(
      ids.move(batch),
      [
        `serpcompany/best.serp.co#349 (#341 phase 2 of 3, move listings): batch ${String(batch).padStart(2, '0')}, ${moves.length} listings`,
        `(${moves[0]?.slug} to ${moves.at(-1)?.slug}). Each gets its tags (listing-tags-set, expecting none) and is filed`,
        'under its hub alone (listing-categories-set). Publish the batches in order, after -01b and before -03.',
        'A listing keeps its batch when the manifests are regenerated.'
      ],
      moves.flatMap(operationsOf)
    )
  }

  add(
    ids.retire,
    [
      `serpcompany/best.serp.co#349 (#341 phase 3 of 3, retire): category-unpublish of the ${plan.retiring.length} narrow categories. Each`,
      'refuses its whole batch while a live listing, or a slug redirect source, is still filed under it.',
      'Publish last, after every -02 batch. Their URLs then answer the 308s -01b wrote.'
    ],
    plan.retiring.map(slug => ({ action: 'category-unpublish', slug }))
  )
  return out
}

/**
 * The owner's read-only checks before publishing (docs/taxonomy-migration.md), each expecting no
 * rows: no listing's own submission in review (`listing-categories-set` refuses it, and its
 * batch), no owner revision open (a move changes the listing's checksum, so the revision could
 * never be approved), and, before `-03-retire`, nothing `category-unpublish` refuses: a live
 * listing, or a slug redirect source, filed under a narrow category.
 */
export function dispatchChecks(mapping: TaxonomyMapping): {
  reviewQueue: string
  revisions: string
  retire: string
} {
  const kept = [
    ...mapping.hubs.map(hub => hub.slug),
    ...(mapping.catchAll ? [mapping.catchAll] : [])
  ]
  return {
    reviewQueue:
      "SELECT l.slug, s.status FROM listing_submissions s JOIN listings l ON l.id=s.listing_id WHERE s.status IN ('paid_pending_review','changes_requested') ORDER BY l.slug",
    revisions:
      "SELECT l.slug, r.status FROM listing_revisions r JOIN listings l ON l.id=r.listing_id WHERE r.status IN ('pending_review','changes_requested') ORDER BY l.slug",
    retire: `SELECT c.slug AS category, l.slug AS listing FROM listing_categories lc JOIN categories c ON c.id=lc.category_id JOIN listings l ON l.id=lc.listing_id WHERE c.is_active=1 AND c.slug NOT IN (${kept.map(slug => `'${slug}'`).join(',')}) AND ((l.status='approved' AND l.is_active=1) OR EXISTS (SELECT 1 FROM listing_slug_redirects r WHERE r.old_slug=l.slug)) ORDER BY c.slug, l.slug`
  }
}

// ---------------------------------------------------------------------------------------------
// The reviewed catalog and the committed files.

export const taxonomyPaths = {
  mapping: 'd1/hygiene/2026-10-10-taxonomy.yaml',
  otherInventory: 'd1/hygiene/2026-10-10-other-inventory.json',
  inventory: 'd1/hygiene/2026-10-10-taxonomy-inventory.json',
  categories: 'd1/hygiene/2026-10-10-categories.json',
  proposals: 'd1/hygiene/2026-10-10-other-categories.yaml',
  audit: 'd1/hygiene/2026-10-10-mismatch-audit.yaml',
  publications: 'd1/publications'
}

export const taxonomyDefaults = { date: '2026-10-10' }

/** The committed manifests this generator owns, by file name. */
export function committedTaxonomyManifests(
  directory = taxonomyPaths.publications,
  date = taxonomyDefaults.date
): string[] {
  return readdirSync(resolve(directory))
    .filter(name => name.startsWith(`${date}-taxonomy-`) && name.endsWith('.yaml'))
    .sort()
}

/** Each listing's phase-2 batch in the committed manifests. */
export function committedBatchAssignments(
  directory = taxonomyPaths.publications,
  date = taxonomyDefaults.date
): Map<string, number> {
  const assignments = new Map<string, number>()
  const prefix = `${date}-taxonomy-02-move-`
  for (const name of committedTaxonomyManifests(directory, date)) {
    if (!name.startsWith(prefix)) continue
    const batch = Number(name.slice(prefix.length, -'.yaml'.length))
    if (!Number.isSafeInteger(batch) || batch < 1) throw new Error(`${name} has no batch number.`)
    const manifest = parse(readFileSync(resolve(directory, name), 'utf8')) as {
      operations?: Array<{ id?: string }>
    }
    for (const operation of manifest.operations ?? [])
      if (operation.id) assignments.set(operation.id, batch)
  }
  return assignments
}

interface InventoryFile<T> {
  source: string[]
  retiredCategories?: string[]
  listings: T[]
}

/** A listing as the committed manifests published after the snapshot leave it. */
interface ReplayListing extends CatalogListing {
  removedBy?: string
}

type CommittedOperation = { action: string } & Record<string, unknown>

/** Operations that change no listing's categories or live state, which the replay skips. */
const NEUTRAL_ACTIONS = new Set([
  'listing-media-update',
  'listing-claim-hold-add',
  'listing-claim-hold-clear',
  'listing-content-remove-suffix',
  'listing-details-set'
])

/**
 * Applies the given manifests, in order, to the listings' categories and live state, refusing an
 * operation whose `expected` disagrees or that it can't replay. Returns the listings that become
 * slug redirect sources, which `planTaxonomy` re-files without tags and checks can move.
 */
export function applyCommittedManifests(
  listings: Map<string, ReplayListing>,
  files: ReadonlyArray<{ name: string; source: string }>
): { redirectSources: Set<string> } {
  const redirectSources = new Set<string>()
  for (const { name, source } of files) {
    const manifest = parse(source) as { operations: CommittedOperation[] }
    for (const operation of manifest.operations) {
      const id = String(operation.id ?? '')
      const listing = listings.get(id)
      const where = `${name}: ${operation.action} ${String(operation.slug ?? '')}`
      switch (operation.action) {
        case 'listing-unpublish':
          if (!listing || !same(listing.categories, operation.categories as string[]))
            throw new Error(`${where} does not match the reviewed catalog.`)
          listing.live = false
          listing.removedBy = name
          break
        case 'listing-categories-set':
          if (!listing || !same(listing.categories, operation.expected as string[]))
            throw new Error(`${where} does not match the reviewed catalog.`)
          listing.categories = [...(operation.categories as string[])]
          break
        case 'listing-slug-redirect':
          redirectSources.add(String((operation.from as { id: string }).id))
          break
        default:
          if (!NEUTRAL_ACTIONS.has(operation.action))
            throw new Error(`${where}: the taxonomy generator does not replay ${operation.action}.`)
      }
    }
  }
  return { redirectSources }
}

/**
 * The committed manifests published after the inventories' snapshot that the generator applies,
 * by file name, in the owner's dispatch order (#321). Named, not discovered: a manifest committed
 * later (#351's, or a hygiene manifest that touches a listing this one moves) changes nothing
 * here, as `mismatch-manifests.ts` names the manifests it follows.
 */
export const taxonomyInputManifests = [
  '2026-10-10-duplicate-listings.yaml',
  '2026-10-10-other-removals.yaml',
  ...Array.from(
    { length: 9 },
    (_, index) => `2026-10-10-other-categories-${String(index + 1).padStart(2, '0')}.yaml`
  ),
  '2026-10-10-duplicate-listings-redirects.yaml',
  '2026-10-10-mismatch-removals.yaml',
  '2026-10-10-mismatch-renames.yaml',
  '2026-10-10-mismatch-categories.yaml',
  '2026-10-10-mismatch-claim-holds-clear.yaml'
] as const

interface Proposal {
  slug: string
  id: string
  primary: string
  secondary?: string[]
  newCategory?: string
  flag?: string
}

interface AuditEntry {
  slug: string
  id: string
  decision: string
  category?: string
}

export interface ReviewedInputs {
  mapping: TaxonomyMapping
  inputs: TaxonomyInputs
  /** The listing each 2026-10-10 removal manifest unpublishes, by id. */
  removed: Map<string, string>
}

/**
 * The reviewed catalog with every later committed manifest applied, #333's clusters (or #340's
 * category for a renamed listing), and the listings to re-file without tags: those another
 * manifest unpublishes, which only move when filed under a retiring category (#337's duplicates
 * that are slug redirect sources would otherwise keep the category from retiring).
 */
export function readReviewedInputs(paths = taxonomyPaths): ReviewedInputs {
  const mapping = parse(readFileSync(resolve(paths.mapping), 'utf8')) as TaxonomyMapping
  const other = JSON.parse(
    readFileSync(resolve(paths.otherInventory), 'utf8')
  ) as InventoryFile<CatalogListing>
  const rest = JSON.parse(
    readFileSync(resolve(paths.inventory), 'utf8')
  ) as InventoryFile<CatalogListing>
  const replayedLine = rest.source.find(line => line.startsWith('Manifests replayed: '))
  if (!replayedLine) throw new Error(`${paths.inventory} names no replayed manifests.`)
  const replayed = new Set(
    replayedLine.slice('Manifests replayed: '.length).replace(/\.$/u, '').split(', ')
  )
  const listings = new Map<string, ReplayListing>()
  for (const listing of other.listings)
    listings.set(listing.id, {
      id: listing.id,
      slug: listing.slug,
      live: true,
      categories: [...listing.categories]
    })
  for (const listing of rest.listings) {
    if (listings.has(listing.id)) throw new Error(`${listing.slug} is in both inventories.`)
    listings.set(listing.id, {
      id: listing.id,
      slug: listing.slug,
      live: listing.live,
      categories: [...listing.categories]
    })
  }
  for (const name of taxonomyInputManifests)
    if (replayed.has(name)) throw new Error(`${name} is in the inventories' snapshot already.`)
  const files = taxonomyInputManifests.map(name => ({
    name,
    source: readFileSync(resolve(paths.publications, name), 'utf8')
  }))
  const { redirectSources } = applyCommittedManifests(listings, files)

  const narrow = (
    JSON.parse(readFileSync(resolve(paths.categories), 'utf8')) as {
      categories: Array<{ slug: string; name: string; description?: string }>
    }
  ).categories
  const catchAll = mapping.catchAll ?? 'other'
  const kept = mapping.hubs.filter(hub => hub.existing).map(hub => hub.slug)
  const known = new Set(narrow.map(category => category.slug))
  const categories: CatalogCategory[] = [
    ...narrow.map(category => ({
      slug: category.slug,
      name: category.name,
      description: category.description ?? '',
      active: true
    })),
    ...[catchAll, ...kept]
      .filter(slug => !known.has(slug))
      .map(slug => ({ slug, name: slug, description: '', active: true })),
    ...(rest.retiredCategories ?? []).map(slug => ({
      slug,
      name: slug,
      description: '',
      active: false
    }))
  ]

  // Clusters: a live Other listing's #333 newCategory, unless a flag holds it; #340's category
  // instead for a listing the owner renamed or fixed.
  const proposals = (
    parse(readFileSync(resolve(paths.proposals), 'utf8')) as { listings: Proposal[] }
  ).listings
  const audit = new Map(
    (parse(readFileSync(resolve(paths.audit), 'utf8')) as { listings: AuditEntry[] }).listings.map(
      entry => [entry.id, entry]
    )
  )
  const clusterTags = new Set(mapping.tags.filter(tag => tag.cluster).map(tag => tag.slug))
  const tagOf = new Map<string, string>()
  for (const tag of mapping.tags) {
    if (!tag.cluster) tagOf.set(tag.slug, tag.slug)
    for (const merged of tag.merges ?? []) tagOf.set(merged, tag.slug)
  }
  const held = new Set((mapping.held ?? []).map(entry => entry.id))
  const clusters = new Map<string, string[]>()
  const unheld: string[] = []
  for (const proposal of proposals) {
    const listing = listings.get(proposal.id)
    if (!listing?.live || !same(listing.categories, [catchAll])) continue
    const decision = audit.get(proposal.id)
    const resolved = decision?.decision === 'rename' || decision?.decision === 'fix-description'
    const cluster =
      resolved && decision?.category && clusterTags.has(decision.category)
        ? decision.category
        : proposal.newCategory
    if (!cluster) continue
    if (proposal.flag && !resolved) {
      if (!held.has(proposal.id)) unheld.push(proposal.slug)
      continue
    }
    if (held.has(proposal.id)) throw new Error(`${proposal.slug} is held but its flag is resolved.`)
    const secondary = (proposal.secondary ?? []).map(slug => {
      const tag = tagOf.get(slug)
      if (!tag) throw new Error(`${proposal.slug}: secondary ${slug} has no tag.`)
      return tag
    })
    clusters.set(proposal.id, [...new Set([cluster, ...secondary])])
  }
  if (unheld.length > 0)
    throw new Error(`Flagged clustered listings missing from held: ${unheld.join(', ')}`)

  const removed = new Map<string, string>()
  for (const listing of listings.values())
    if (listing.removedBy) removed.set(listing.id, listing.removedBy)
  return {
    mapping,
    removed,
    inputs: {
      mapping,
      catalog: {
        listings: [...listings.values()].map(listing => ({
          id: listing.id,
          slug: listing.slug,
          live: listing.live,
          categories: listing.categories
        })),
        categories,
        slugRedirectSources: redirectSources
      },
      clusters,
      untagged: new Set(removed.keys())
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const { mapping, inputs } = readReviewedInputs()
  const plan = planTaxonomy(inputs)
  const manifests = buildTaxonomyManifests(
    plan,
    { date: taxonomyDefaults.date, keywordsCheckedAt: mapping.keywordsCheckedAt },
    committedBatchAssignments()
  )
  for (const name of committedTaxonomyManifests()) rmSync(resolve(taxonomyPaths.publications, name))
  for (const { id, source } of manifests) {
    writeFileSync(resolve(taxonomyPaths.publications, `${id}.yaml`), source)
    console.log(`Wrote ${taxonomyPaths.publications}/${id}.yaml`)
  }
}

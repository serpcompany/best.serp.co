import { createHash } from 'node:crypto'
import { type HostedImageFormat, IMAGE_CONTENT_TYPES } from '../../apps/web/src/db/media-format'
import { mediaKey } from '../../apps/web/src/db/media-keys'

/**
 * A synthetic catalog at production scale (serpcompany/best.serp.co#314), for the tests that need
 * catalog-sized data: D1 bills and limits by rows read, and a lost index or a full scan only shows
 * at catalog size (#41, #77). Local and CI data never come from the real catalog (#311), so this
 * generates one with the v1 import's size and shape, which the rows-read budgets in
 * `scripts/d1-workerd-queries.test.ts` were measured on:
 *
 * - 3,422 public listings in 141 active categories: one catch-all holding 2,868 of them, two large
 *   overlapping categories (335 and 261 members), a few medium ones, and a long tail of 1 to 5;
 * - 319 listings in several categories (up to 9), FAQs on 335 listings, resource links on 337,
 *   a hosted logo on most listings and featured images on most of those, and 335 featured;
 *
 * and what production has gained since: unpublished listings (a retired category's among them,
 * #260), slug redirects, listing owners (current and revoked), and submissions in every status;
 * and the taxonomy's scale (#341, design 3.4): 130 tags (2 retired) with about 3,700 memberships,
 * one tag of 335 listings and a listing with 9 tags, 60 best pages (tag, category and both) with 0
 * to 10 pins, and 140 taxonomy redirects. The categories stay as they are: they remain the worst
 * case for the category shapes, and each tag sits under one of them as its hub.
 *
 * Deterministic: one seeded PRNG drives every choice, so a seed always yields the same rows. It is
 * generated at test time, never checked in. Names are generated pseudo-words and every URL is on a
 * reserved `.test` host or on `example.com`, `example.net` or `example.org` (RFC 2606), so no real
 * product, domain or person appears.
 */

export const SCALE_CATALOG_SEED = 314
/** The catch-all category, as on the site; submissions name it too. */
export const CATCH_ALL_CATEGORY = 'other'
/** The affiliate redirect host most websites point at (production's are `serp.ly` links). */
export const AFFILIATE_HOST = 'go.example.net'

export type SqlValue = number | string | null
export interface SqlStatement {
  params: SqlValue[]
  sql: string
}

export interface ScaleCategory {
  description: string
  id: number
  isActive: boolean
  name: string
  slug: string
  sortOrder: number
}

export interface ScaleListing {
  /** Category slugs, primary first. */
  categories: string[]
  /** Tag slugs, the most central first (#341). */
  tags: string[]
  checksum: string
  content: string
  createdAt: string
  description: string
  displayOrder: number
  entityType: string | null
  id: string
  isActive: boolean
  isFeatured: boolean
  isUnofficial: boolean
  linkRel: 'follow' | 'nofollow' | 'sponsored'
  name: string
  priority: 'high' | 'low' | 'medium' | null
  publishedAt: string | null
  slug: string
  source: 'admin' | 'submission'
  status: 'approved' | 'draft' | 'rejected' | 'review'
  updatedAt: string
  website: string
}

export interface ScaleMedia {
  bytes: number | null
  contentType: string | null
  height: number | null
  kind: 'image' | 'logo' | 'video'
  listingId: string
  mediaKey: string | null
  sha256: string | null
  sortOrder: number
  url: string
  width: number | null
}

export interface ScaleSubmission {
  badgeVerifiedAt: string | null
  blockKey: string
  categorySlug: string
  content: string
  createdAt: string
  description: string
  draftSavedAt: string | null
  id: string
  lastVerificationAt: string | null
  lastVerificationError: string | null
  listingId: string | null
  logoUrl: string
  name: string
  ownerUserId: string
  paidAt: string | null
  plan: 'free' | 'paid' | null
  publishedChecksum: string | null
  rejectionCategory: 'other' | 'prohibited' | null
  rejectionReason: string | null
  reviewedAt: string | null
  reviewedBy: string | null
  reviewerNote: string | null
  slug: string
  status: (typeof SUBMISSION_STATUSES)[number]
  verificationAttempts: number
  website: string
  withdrawalReason: 'expired' | 'owner' | null
}

export interface ScaleTag {
  /** Its hub. */
  categorySlug: string
  description: string
  id: number
  isActive: boolean
  name: string
  slug: string
  sortOrder: number
}

export interface ScaleBestPage {
  categorySlug: string | null
  id: number
  intro: string
  keyword: string
  keywordCheckedAt: string | null
  keywordVolume: number | null
  listSize: number
  slug: string
  sortOrder: number
  tagSlug: string | null
  title: string
}

export interface ScaleBestPageEntry {
  bestPageId: number
  blurb: string | null
  excluded: boolean
  listingId: string
  position: number | null
}

export interface ScaleTaxonomyRedirect {
  sourceKind: 'best' | 'category' | 'tag'
  sourceSlug: string
  targetKind: 'best' | 'category' | 'directory' | 'tag'
  /** The target's slug; null for the directory. */
  targetSlug: string | null
}

export interface ScaleCatalog {
  bestPageEntries: ScaleBestPageEntry[]
  bestPages: ScaleBestPage[]
  categories: ScaleCategory[]
  faqs: Array<{ answer: string; listingId: string; question: string; sortOrder: number }>
  listings: ScaleListing[]
  media: ScaleMedia[]
  owners: Array<{
    listingId: string
    revokedAt: string | null
    revokedReason: string | null
    userId: string
    verifiedAt: string
    verifiedVia: 'admin' | 'badge_claim' | 'paid_claim' | 'submission'
  }>
  publication: { checksum: string; manifestId: string; publishedAt: string; version: number }
  redirects: Array<{ listingId: string; newSlug: string; oldSlug: string }>
  resources: Array<{ label: string; listingId: string; sortOrder: number; url: string }>
  submissions: ScaleSubmission[]
  tags: ScaleTag[]
  taxonomyRedirects: ScaleTaxonomyRedirect[]
  urlBlocks: Array<{ blockedAt: string; reason: string; submissionId: string; urlKey: string }>
  users: Array<{ email: string; id: string; name: string }>
}

const SUBMISSION_STATUSES = [
  'draft',
  'pending_badge',
  'verified',
  'paid_pending_review',
  'changes_requested',
  'approved',
  'rejected',
  'withdrawn'
] as const

/** Public listings outside the catch-all, by how many categories they have (v1: 235, 292, …). */
const CATEGORY_COUNTS = [
  { categories: 9, listings: 1 },
  { categories: 4, listings: 3 },
  { categories: 3, listings: 23 },
  { categories: 2, listings: 292 },
  { categories: 1, listings: 235 }
]
const CATCH_ALL_LISTINGS = 2_868
/** Members of the other active categories, largest first, then 130 of 1 to 5 members. */
const CATEGORY_SIZES = [335, 261, 31, 25, 23, 15, 9, 9, 9, 7]
/** The two large categories, which overlap the way the v1 import's two largest did. */
const LARGE_CATEGORIES = ['video-downloaders', 'ai-writing-tools']
const SMALL_CATEGORIES = 130
/** Unpublished listings: a retired category's (#260), dead or hijacked domains (#100, #104). */
const RETIRED_LISTINGS = 150
const UNPUBLISHED_CATCH_ALL = 120
const UNPUBLISHED_ELSEWHERE = 30
/** Public listings published after the bulk import, newest first in publication order. */
const LATER_LISTINGS = 110
const FEATURED_LISTINGS = 335
const FAQ_LISTINGS = 335
const RESOURCE_LISTINGS = 337

/**
 * The taxonomy (#341, design 3.4), drawn from its own PRNG so the rows above stay as they were.
 * Tag sizes are memberships: one of 335 for headroom, then a long tail like the real tags' (95 of
 * 10 or more, 28 of 3 to 9, 2 below 3), and 2 retired tags that keep their memberships.
 */
const TAXONOMY_SEED_OFFSET = 341
const HEADROOM_TAG_SIZE = 335
const LARGE_TAGS = 96
const MEDIUM_TAG_SIZES = Array.from({ length: 28 }, (_, index) => 3 + (index % 7))
const SMALL_TAG_SIZES = [2, 1, 1]
const RETIRED_TAG_SIZES = [12, 4]
/** How many tags a tagged listing has (weights), besides the one listing with 9. */
const TAG_COUNTS: Array<[number, number]> = [
  [1, 88],
  [2, 9],
  [3, 2],
  [4, 1]
]
/** The hubs tags sit under: the active categories with the most public listings, but `other`. */
const TAG_HUBS = 16
const TAG_BEST_PAGES = 30
const CATEGORY_BEST_PAGES = 15
const INTERSECTION_BEST_PAGES = 15
const TAXONOMY_MANIFEST = 'scale-catalog-taxonomy'

const BULK_PUBLISHED_AT = '2026-05-16'
const BULK_CREATED_AT = '2026-09-30T10:00:00.000Z'
const ADMIN = 'scale-admin'

const TOPICS: ReadonlyArray<readonly [string, string]> = [
  ['Video', 'video clips'],
  ['Image', 'images'],
  ['Audio', 'audio files'],
  ['Podcast', 'podcast episodes'],
  ['Writing', 'blog posts'],
  ['SEO', 'search rankings'],
  ['Email', 'email campaigns'],
  ['Social Media', 'social posts'],
  ['Course', 'course lessons'],
  ['Ecommerce', 'store listings'],
  ['Analytics', 'site metrics'],
  ['CRM', 'customer records'],
  ['Invoice', 'invoices'],
  ['GPU', 'GPU workloads'],
  ['Hosting', 'web apps'],
  ['Livestream', 'live streams'],
  ['Photo', 'photos'],
  ['Resume', 'resumes'],
  ['Slide', 'slide decks'],
  ['Translation', 'translations'],
  ['Chatbot', 'chat replies'],
  ['Code', 'code reviews'],
  ['Design', 'design files'],
  ['Survey', 'surveys'],
  ['Calendar', 'meetings'],
  ['Notes', 'meeting notes'],
  ['Password', 'passwords'],
  ['VPN', 'private connections'],
  ['Backup', 'backups'],
  ['Website', 'websites']
]
const KINDS: ReadonlyArray<readonly [string, string]> = [
  ['Downloaders', 'saves'],
  ['Generators', 'creates'],
  ['Editors', 'edits'],
  ['Tools', 'handles'],
  ['Platforms', 'hosts'],
  ['Trackers', 'tracks'],
  ['Assistants', 'drafts'],
  ['Templates', 'ships templates for'],
  ['Converters', 'converts'],
  ['Builders', 'builds']
]
const AUDIENCES = [
  'small teams',
  'creators',
  'agencies',
  'students',
  'developers',
  'marketers',
  'online stores',
  'researchers',
  'freelancers',
  'support teams'
]
const TAILS = ['', '', ' in minutes', ' without code', ' with AI', ' from any browser', ' at scale']
const EXTRA_SENTENCES = [
  'Free plan available.',
  'Works on Windows and macOS.',
  'Includes a browser extension.',
  'Exports to every common format.',
  'Pay as you go, no subscription.',
  'Built for teams of any size.'
]
const DESCRIPTORS = ['AI', 'Studio', 'Labs', 'Pro', 'Hub', 'Kit', 'Cloud', 'Flow', 'Desk']
const ONSETS = 'b bl br d dr f fl fr g gl gr h j k kl l m n p pl pr qu r s sk sl sp st t tr v w z'
const VOWELS = 'a e i o u ai ea io oa ou'
const CODAS = '- - - b d f g k l m n p r s t x nd rk st sk lt'
const ENDINGS = 'ly ly io ix ora um ia eo ify ster wise ful zy on ar ent ica'
const ACCENTS: Record<string, string> = { a: 'á', e: 'é', o: 'ö', u: 'ü' }
const FAQ_QUESTIONS = [
  'Is {name} free?',
  'Does {name} work on mobile?',
  'How do I cancel {name}?',
  'What does {name} export?',
  'Can {name} handle large files?',
  'Does {name} have an API?',
  'Who is {name} for?',
  'Does {name} support teams?',
  'Where does {name} store my data?',
  'Which formats does {name} support?',
  'Is there a free trial of {name}?',
  'How do I contact {name} support?',
  'Does {name} offer refunds?'
]
const RESOURCE_LABELS = [
  'Pricing',
  'Documentation',
  'Blog',
  'Support',
  'Changelog',
  'Status',
  'API reference',
  'Community',
  'Tutorials',
  'Careers',
  'Affiliates',
  'Press kit',
  'Security'
]
/** How many FAQs a listing with FAQs has, and how often (the v1 import's spread). */
const FAQ_COUNTS: Array<[number, number]> = [
  [4, 1],
  [5, 179],
  [6, 47],
  [7, 23],
  [8, 15],
  [9, 3],
  [10, 19],
  [11, 10],
  [12, 29],
  [13, 9]
]
const RESOURCE_COUNTS: Array<[number, number]> = [
  [1, 3],
  [3, 25],
  [4, 1],
  [7, 222],
  [8, 20],
  [9, 18],
  [10, 38],
  [11, 7],
  [12, 2],
  [13, 1]
]
const IMAGE_COUNTS: Array<[number, number]> = [
  [1, 2655],
  [2, 43],
  [3, 3],
  [4, 1],
  [5, 4],
  [6, 5],
  [7, 1],
  [8, 1],
  [9, 2],
  [10, 1],
  [12, 3]
]

/** A small, fast, seedable PRNG (mulberry32): integer math only, so every runtime agrees. */
class Random {
  private state: number

  constructor(seed: number) {
    this.state = seed >>> 0
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0
    let value = this.state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }

  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1))
  }

  chance(probability: number): boolean {
    return this.next() < probability
  }

  pick<T>(values: readonly T[]): T {
    return values[Math.floor(this.next() * values.length)] as T
  }

  weighted(entries: ReadonlyArray<readonly [number, number]>): number {
    const total = entries.reduce((sum, [, weight]) => sum + weight, 0)
    let roll = this.next() * total
    for (const [value, weight] of entries) {
      roll -= weight
      if (roll < 0) return value
    }
    return (entries.at(-1) as readonly [number, number])[0]
  }

  shuffle<T>(values: T[]): T[] {
    for (let index = values.length - 1; index > 0; index -= 1) {
      const other = Math.floor(this.next() * (index + 1))
      ;[values[index], values[other]] = [values[other] as T, values[index] as T]
    }
    return values
  }

  hex(length: number): string {
    let value = ''
    while (value.length < length) value += Math.floor(this.next() * 16).toString(16)
    return value
  }

  uuid(): string {
    const hex = this.hex(32)
    const variant = '89ab'[Math.floor(this.next() * 4)]
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
  }
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')
const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '')
const capitalize = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1)
/** Code-unit order: unlike `localeCompare`, the same on every runtime and ICU version. */
const byCodeUnit = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0

/** An ISO instant `days` (fractional) after 2026-06-01, the first day after the bulk import. */
function laterInstant(days: number): string {
  return new Date(Date.UTC(2026, 5, 1) + Math.round(days * 86_400_000)).toISOString()
}

function words(random: Random): () => string {
  const onsets = ONSETS.split(' ')
  const vowels = VOWELS.split(' ')
  const codas = CODAS.split(' ').map(coda => (coda === '-' ? '' : coda))
  const endings = ENDINGS.split(' ')
  const used = new Set<string>()
  return () => {
    for (;;) {
      const syllables = random.chance(0.55) ? 2 : 1
      let word = ''
      for (let index = 0; index < syllables; index += 1) {
        word += random.pick(onsets) + random.pick(vowels) + random.pick(codas)
      }
      word += random.pick(endings)
      if (word.length >= 4 && word.length <= 14 && !used.has(word)) {
        used.add(word)
        return word
      }
    }
  }
}

interface CategoryPlan {
  kind: readonly [string, string]
  topic: readonly [string, string]
}

function buildCategories(random: Random): {
  categories: ScaleCategory[]
  plans: Map<string, CategoryPlan>
} {
  const combinations: CategoryPlan[] = TOPICS.flatMap(topic => KINDS.map(kind => ({ kind, topic })))
  const planFor = (topic: string, kind: string) =>
    combinations.find(plan => plan.topic[0] === topic && plan.kind[0] === kind) as CategoryPlan
  const video = planFor('Video', 'Downloaders')
  // The two large categories, 138 more active ones, and one retired (#260); the catch-all
  // has no topic of its own.
  const named: Array<{ name: string; plan: CategoryPlan }> = [
    { name: 'Video Downloaders', plan: video },
    { name: 'AI Writing Tools', plan: planFor('Writing', 'Tools') }
  ]
  for (const plan of random.shuffle(combinations.filter(plan => plan !== video))) {
    if (named.length === 141) break
    const name = `${random.chance(0.25) ? 'AI ' : ''}${plan.topic[0]} ${plan.kind[0]}`
    if (!named.some(entry => entry.name === name)) named.push({ name, plan })
  }
  const retired = slugify((named.at(-1) as { name: string }).name)
  const plans = new Map(named.map(entry => [slugify(entry.name), entry.plan]))
  const categories = [...named.map(entry => entry.name), 'Other']
    .map(name => ({ name, slug: slugify(name) }))
    .sort((left, right) => byCodeUnit(left.slug, right.slug))
    .map(({ name, slug }, index) => ({
      description:
        slug === CATCH_ALL_CATEGORY
          ? 'Products that fit no other category yet.'
          : `Compare ${name.replace(/^AI /u, 'AI-powered ').toLowerCase()} for ${random.pick(AUDIENCES)}.`,
      id: index + 1,
      isActive: slug !== retired,
      name,
      slug,
      sortOrder: index
    }))
  return { categories, plans }
}

/**
 * Category slugs for each public listing outside the catch-all, primary first: the large and
 * medium categories' slots and the small tail, dealt at random with no category twice on one
 * listing. The nine-category listing takes small categories only, as in the v1 import.
 */
function dealMemberships(random: Random, topical: string[]): string[][] {
  const large = LARGE_CATEGORIES
  const rest = random.shuffle(topical.filter(slug => !large.includes(slug)))
  const sized = [...large, ...rest.slice(0, CATEGORY_SIZES.length - large.length)]
  const tail = rest.slice(CATEGORY_SIZES.length - large.length)
  if (tail.length !== SMALL_CATEGORIES) throw new Error('Scale catalog: wrong category count.')
  const tailSizes = tail.map(() => 1)
  const membershipTotal = CATEGORY_COUNTS.reduce(
    (sum, entry) => sum + entry.categories * entry.listings,
    0
  )
  let extra = membershipTotal - CATEGORY_SIZES.reduce((sum, size) => sum + size, 0) - tail.length
  while (extra > 0) {
    // Skewed toward the front, so most small categories keep one or two members.
    const index = Math.floor(random.next() * random.next() * tail.length)
    if ((tailSizes[index] as number) < 5) {
      tailSizes[index] = (tailSizes[index] as number) + 1
      extra -= 1
    }
  }
  const sizes = [...CATEGORY_SIZES, ...tailSizes]
  const slots = random.shuffle(
    [...sized, ...tail].flatMap((slug, index) => Array<string>(sizes[index] as number).fill(slug))
  )

  const memberships: string[][] = []
  for (const { categories, listings } of CATEGORY_COUNTS) {
    for (let listing = 0; listing < listings; listing += 1) {
      const chosen: string[] = []
      for (let index = 0; chosen.length < categories; index += 1) {
        if (index >= slots.length) throw new Error('Scale catalog: no slot left to deal.')
        const slug = slots[index] as string
        const allowed = categories < 9 || tail.includes(slug)
        if (!chosen.includes(slug) && allowed) {
          chosen.push(slug)
          slots.splice(index, 1)
          index -= 1
        }
      }
      memberships.push(chosen)
    }
  }
  if (slots.length > 0) throw new Error('Scale catalog: memberships were left undealt.')
  return random.shuffle(memberships)
}

function listingContent(random: Random, name: string, object: string): string {
  const sentence = () =>
    `${name} ${random.pick(['keeps', 'turns', 'lets you review', 'organizes', 'checks'])} ${object} ${random.pick(['in one place', 'on a schedule', 'with a few clicks', 'for the whole team', 'before they ship'])}.`
  const section = (heading: string, paragraphs: number) =>
    `## ${heading}\n\n${Array.from({ length: paragraphs }, () =>
      Array.from({ length: random.int(2, 4) }, sentence).join(' ')
    ).join('\n\n')}`
  const features = `## Features\n\n${Array.from(
    { length: random.int(3, 6) },
    () =>
      `- ${capitalize(random.pick(['fast', 'shared', 'private', 'bulk', 'scheduled']))} ${object}`
  ).join('\n')}`
  // A few long descriptions, like the import's longest (16 KB).
  const overview = random.chance(0.01) ? 40 : random.int(1, 3)
  return [section('Overview', overview), features, section('Pricing', 1)].join('\n\n')
}

/** "photo converters" → "Photo Converters". */
const titleCase = (value: string): string =>
  value.replace(/\b[a-z]/gu, letter => letter.toUpperCase())

/**
 * Tags with their memberships, best pages, and taxonomy redirects (#341) for the generated
 * listings, written onto `listing.tags`. Tags are topic and kind pairs no category uses, so no tag
 * shares a category's slug, and each sits under one of the largest categories (its hub). Public
 * listings carry them, and so do unpublished ones outside the retired category (the migration
 * re-files those too), most with one tag; the rest, like Other's residue, have none.
 */
function buildTaxonomy(
  random: Random,
  categories: ScaleCategory[],
  listings: ScaleListing[],
  plans: Map<string, CategoryPlan>
): Pick<ScaleCatalog, 'bestPageEntries' | 'bestPages' | 'tags' | 'taxonomyRedirects'> {
  const retiredCategory = (categories.find(category => !category.isActive) as ScaleCategory).slug
  const isPublic = (listing: ScaleListing) => listing.status === 'approved' && listing.isActive
  const publicCount = new Map<string, number>()
  for (const listing of listings.filter(isPublic)) {
    for (const slug of listing.categories) publicCount.set(slug, (publicCount.get(slug) ?? 0) + 1)
  }
  const ranked = categories
    .filter(category => category.isActive && category.slug !== CATCH_ALL_CATEGORY)
    .sort(
      (left, right) =>
        (publicCount.get(right.slug) ?? 0) - (publicCount.get(left.slug) ?? 0) ||
        byCodeUnit(left.slug, right.slug)
    )
  const hubs = ranked.slice(0, TAG_HUBS)

  const used = [...plans.values()]
  const free = TOPICS.flatMap(topic => KINDS.map(kind => ({ kind, topic }))).filter(
    plan => !used.some(other => other.topic === plan.topic && other.kind === plan.kind)
  )
  const sizes = [
    HEADROOM_TAG_SIZE,
    ...Array.from({ length: LARGE_TAGS }, (_, index) => Math.round(180 / Math.sqrt(index + 1))),
    ...MEDIUM_TAG_SIZES,
    ...SMALL_TAG_SIZES
  ]
  const activeTags = sizes.length
  const tags: ScaleTag[] = random
    .shuffle(free)
    .slice(0, activeTags + RETIRED_TAG_SIZES.length)
    .map((plan, index) => {
      const name = `${plan.topic[0]} ${plan.kind[0]}`
      return {
        categorySlug: (hubs[index % hubs.length] as ScaleCategory).slug,
        description: `${name} for ${random.pick(AUDIENCES)}.`,
        id: index + 1,
        isActive: index < activeTags,
        name,
        slug: slugify(name),
        sortOrder: index
      }
    })
  sizes.push(...RETIRED_TAG_SIZES)

  // Deal each tag's slots to listings, no tag twice on one listing; the first public listing
  // takes the headroom tag and eight more, the widest related-by-tags scan.
  const slots = random.shuffle(
    tags.flatMap((tag, index) => Array<string>(sizes[index] as number).fill(tag.slug))
  )
  const taggable = random.shuffle(
    listings.filter(
      listing => listing.status === 'approved' && !listing.categories.includes(retiredCategory)
    )
  )
  const widest = taggable.findIndex(isPublic)
  taggable.unshift(...taggable.splice(widest, 1))
  const take = (listing: ScaleListing, count: number) => {
    for (let index = 0; listing.tags.length < count && index < slots.length; index += 1) {
      const slug = slots[index] as string
      if (!listing.tags.includes(slug)) {
        listing.tags.push(slug)
        slots.splice(index, 1)
        index -= 1
      }
    }
  }
  const [first, ...rest] = taggable as [ScaleListing, ...ScaleListing[]]
  slots.splice(slots.indexOf((tags[0] as ScaleTag).slug), 1)
  first.tags.push((tags[0] as ScaleTag).slug)
  take(first, 9)
  for (const listing of rest) {
    if (slots.length === 0) break
    take(listing, random.weighted(TAG_COUNTS))
  }
  if (slots.length > 0) throw new Error('Scale catalog: tag memberships were left undealt.')

  // Best pages on a tag, on a category, and on a tag within its hub, with 0 to 10 pins.
  const live = listings.filter(isPublic)
  const tagMembers = (slug: string) => live.filter(listing => listing.tags.includes(slug))
  const inCategory = (slug: string) => live.filter(listing => listing.categories.includes(slug))
  const active = tags.filter(tag => tag.isActive)
  const pools: Array<{
    category: ScaleCategory | null
    keyword: string
    pool: ScaleListing[]
    slug: string
    tag: ScaleTag | null
  }> = [
    ...active.slice(0, TAG_BEST_PAGES).map(tag => ({
      category: null,
      keyword: tag.name.toLowerCase(),
      pool: tagMembers(tag.slug),
      slug: tag.slug,
      tag
    })),
    ...ranked.slice(0, CATEGORY_BEST_PAGES).map(category => ({
      category,
      keyword: category.name.toLowerCase(),
      pool: inCategory(category.slug),
      slug: category.slug,
      tag: null
    })),
    // A tag within the category most of its public listings share, as `ai-seo` within
    // `ecommerce`: not necessarily the tag's own hub.
    ...active.slice(TAG_BEST_PAGES, TAG_BEST_PAGES + INTERSECTION_BEST_PAGES).map(tag => {
      const shared = new Map<string, number>()
      for (const listing of tagMembers(tag.slug)) {
        for (const slug of listing.categories) shared.set(slug, (shared.get(slug) ?? 0) + 1)
      }
      const category =
        ranked
          .filter(candidate => shared.has(candidate.slug))
          .sort((left, right) => (shared.get(right.slug) ?? 0) - (shared.get(left.slug) ?? 0))[0] ??
        (hubs.find(hub => hub.slug === tag.categorySlug) as ScaleCategory)
      const keyword = `${tag.name} for ${category.name}`.toLowerCase()
      return {
        category,
        keyword,
        pool: tagMembers(tag.slug).filter(listing => listing.categories.includes(category.slug)),
        slug: slugify(keyword),
        tag
      }
    })
  ]
  const bestPages: ScaleBestPage[] = []
  const bestPageEntries: ScaleBestPageEntry[] = []
  for (const [index, page] of pools.entries()) {
    const id = index + 1
    const volume = random.chance(0.6) ? random.int(100, 60_000) : null
    bestPages.push({
      categorySlug: page.category?.slug ?? null,
      id,
      intro: `Compare the best ${page.keyword} for ${random.pick(AUDIENCES)}. ${random.pick(EXTRA_SENTENCES)}`,
      keyword: page.keyword,
      keywordCheckedAt: volume === null ? null : laterInstant(random.int(126, 128)),
      keywordVolume: volume,
      listSize: index === 0 ? 25 : index % 7 === 3 ? 5 : 10,
      slug: page.slug,
      sortOrder: index,
      tagSlug: page.tag?.slug ?? null,
      title: `Best ${titleCase(page.keyword)}`
    })
    // A pin joins the pool even when the rule doesn't select it: a small intersection pins from
    // its tag.
    const candidates = random.shuffle([
      ...page.pool,
      ...(page.tag ? tagMembers(page.tag.slug).filter(listing => !page.pool.includes(listing)) : [])
    ])
    const pins = candidates.slice(0, index % 11)
    for (const [position, listing] of pins.entries()) {
      bestPageEntries.push({
        bestPageId: id,
        blurb: position === 0 ? `${listing.name} leads for ${page.keyword}.` : null,
        excluded: false,
        listingId: listing.id,
        position: position + 1
      })
    }
    if (index % 4 === 1) {
      for (const listing of page.pool.filter(item => !pins.includes(item)).slice(0, 2)) {
        bestPageEntries.push({
          bestPageId: id,
          blurb: null,
          excluded: true,
          listingId: listing.id,
          position: null
        })
      }
    }
  }

  // Old URLs: narrow categories that became tags (or the best page on that tag), renamed tags,
  // best pages and hubs, and the retired and catch-all categories, sent to the directory.
  const bestOnTag = new Map(
    bestPages
      .filter(page => page.tagSlug && !page.categorySlug)
      .map(page => [page.tagSlug, page.slug])
  )
  const taxonomyRedirects: ScaleTaxonomyRedirect[] = [
    ...active.slice(0, 100).map(tag => {
      const best = bestOnTag.get(tag.slug)
      return {
        sourceKind: 'category' as const,
        sourceSlug: tag.slug,
        targetKind: best ? ('best' as const) : ('tag' as const),
        targetSlug: best ?? tag.slug
      }
    }),
    ...active.slice(100, 120).map(tag => ({
      sourceKind: 'tag' as const,
      sourceSlug: `${tag.slug}-old`,
      targetKind: 'tag' as const,
      targetSlug: tag.slug
    })),
    ...bestPages.slice(0, 10).map(page => ({
      sourceKind: 'best' as const,
      sourceSlug: `${page.slug}-old`,
      targetKind: 'best' as const,
      targetSlug: page.slug
    })),
    ...hubs.slice(0, 8).map(hub => ({
      sourceKind: 'category' as const,
      sourceSlug: `${hub.slug}-old`,
      targetKind: 'category' as const,
      targetSlug: hub.slug
    })),
    ...[retiredCategory, `${CATCH_ALL_CATEGORY}-old`].map(slug => ({
      sourceKind: 'category' as const,
      sourceSlug: slug,
      targetKind: 'directory' as const,
      targetSlug: null
    }))
  ]
  return { bestPageEntries, bestPages, tags, taxonomyRedirects }
}

/** Generates the catalog for `seed`. Same seed, same rows. */
export function generateScaleCatalog(seed: number = SCALE_CATALOG_SEED): ScaleCatalog {
  const random = new Random(seed)
  const word = words(random)
  const { categories, plans } = buildCategories(random)
  const retired = (categories.find(category => !category.isActive) as ScaleCategory).slug
  const topical = categories
    .filter(category => category.isActive && category.slug !== CATCH_ALL_CATEGORY)
    .map(category => category.slug)

  // Every listing's categories and publication state, before names and dates.
  type Draft = Pick<ScaleListing, 'categories' | 'isActive' | 'status'> & { public: boolean }
  const drafts: Draft[] = [
    ...Array.from({ length: CATCH_ALL_LISTINGS }, () => [CATCH_ALL_CATEGORY]),
    ...dealMemberships(random, topical)
  ].map(categories => ({ categories, isActive: true, public: true, status: 'approved' as const }))
  const unpublished = (categories: string[]): Draft => ({
    categories,
    isActive: false,
    public: false,
    status: 'approved'
  })
  const smaller = topical.filter(slug => !LARGE_CATEGORIES.includes(slug))
  for (let index = 0; index < RETIRED_LISTINGS; index += 1) {
    drafts.push(unpublished(index % 3 === 0 ? [retired, random.pick(smaller)] : [retired]))
  }
  for (let index = 0; index < UNPUBLISHED_CATCH_ALL; index += 1) {
    drafts.push(unpublished([CATCH_ALL_CATEGORY]))
  }
  // In one category each, as every listing #100 and #104 unpublished is.
  for (let index = 0; index < UNPUBLISHED_ELSEWHERE; index += 1) {
    drafts.push(unpublished([random.pick(smaller)]))
  }
  // Listings never published: admin drafts, and ones held in review or rejected.
  for (const status of ['draft', 'draft', 'review', 'rejected'] as const) {
    for (const categories of [[random.pick(topical)], [CATCH_ALL_CATEGORY]]) {
      drafts.push({ categories, isActive: true, public: false, status })
    }
  }

  const order = random.shuffle(drafts.map((_, index) => index))
  const publicIndexes = order.filter(index => drafts[index]?.public)
  const later = new Map(publicIndexes.slice(0, LATER_LISTINGS).map((index, rank) => [index, rank]))
  const featured = new Set(random.shuffle([...publicIndexes]).slice(0, FEATURED_LISTINGS))
  const ids = new Set<string>()
  const listings: ScaleListing[] = []
  for (const index of order) {
    const draft = drafts[index] as Draft
    const stem = word()
    const domain = random.chance(0.9)
    const descriptor = random.chance(0.3) ? random.pick(DESCRIPTORS) : null
    const plan = plans.get(
      (draft.categories[0] as string) === CATCH_ALL_CATEGORY
        ? random.pick(topical)
        : (draft.categories[0] as string)
    ) as CategoryPlan
    const object = plan.topic[1]
    const accented = random.chance(0.01)
    const display = accented ? stem.replace(/[aeou]/u, vowel => ACCENTS[vowel] ?? vowel) : stem
    const name = `${capitalize(display)}${descriptor ? ` ${descriptor}` : ''}`
    const slug = domain ? `${stem}.test` : `${stem}-${slugify(descriptor ?? plan.kind[0])}`
    let id = `lst_${random.hex(24)}`
    while (ids.has(id)) id = `lst_${random.hex(24)}`
    ids.add(id)
    const description = `${name} ${plan.kind[1]} ${object} for ${random.pick(AUDIENCES)}${random.pick(TAILS)}.${
      random.chance(0.5) ? ` ${random.pick(EXTRA_SENTENCES)}` : ''
    }${accented ? ` Made by ${capitalize(display)} OÜ.` : ''}`
    const rank = later.get(index)
    const publishedAt =
      draft.status !== 'approved'
        ? null
        : rank === undefined
          ? BULK_PUBLISHED_AT
          : laterInstant(rank * 1.1)
    const createdAt = rank === undefined ? BULK_CREATED_AT : (publishedAt as string)
    const content = listingContent(random, name, object)
    const fields = {
      categories: draft.categories,
      tags: [] as string[],
      content,
      createdAt,
      description,
      displayOrder: 0,
      entityType: random.chance(0.01) ? 'software' : null,
      id,
      isActive: draft.isActive,
      isFeatured: draft.public ? featured.has(index) : random.chance(0.1),
      isUnofficial: random.chance(0.01),
      linkRel: random.weighted([
        [0, 95],
        [1, 3],
        [2, 2]
      ]),
      name,
      priority: random.chance(0.01) ? random.pick(['high', 'medium', 'low'] as const) : null,
      publishedAt,
      slug,
      source: 'admin' as const,
      status: draft.status,
      // A few edited since, after every publication date.
      updatedAt: random.chance(0.05) ? laterInstant(random.int(122, 125)) : createdAt,
      website:
        domain && random.chance(0.02) ? `https://${slug}/` : `https://${AFFILIATE_HOST}/${slug}`
    }
    listings.push({
      ...fields,
      checksum: sha256(JSON.stringify([fields.slug, name, description, fields.website, content])),
      linkRel: (['follow', 'nofollow', 'sponsored'] as const)[fields.linkRel] ?? 'follow'
    })
  }
  // Display order, as in the v1 import: the bulk import's listings by name, then the ones
  // published since, oldest first, each taking the next display order as approval does. Search
  // and the directory pages sort by name, so this order decides how many rows their top-N sort
  // reads.
  const bulkPublished = (listing: ScaleListing) =>
    listing.publishedAt === null || listing.publishedAt === BULK_PUBLISHED_AT
  const byName = (left: ScaleListing, right: ScaleListing) =>
    byCodeUnit(left.name.toLowerCase(), right.name.toLowerCase()) ||
    byCodeUnit(left.slug, right.slug)
  listings.splice(
    0,
    listings.length,
    ...listings.filter(bulkPublished).sort(byName),
    ...listings
      .filter(listing => !bulkPublished(listing))
      .sort((left, right) => byCodeUnit(left.publishedAt as string, right.publishedAt as string))
  )
  for (const [position, listing] of listings.entries()) listing.displayOrder = position
  const live = listings.filter(listing => listing.status === 'approved' && listing.isActive)
  const liveDomains = live.filter(listing => listing.slug.endsWith('.test'))

  // FAQs and resource links on the same listings, as the import's richest entries had both.
  const enriched = random.shuffle([...live]).slice(0, Math.max(FAQ_LISTINGS, RESOURCE_LISTINGS))
  const faqs: ScaleCatalog['faqs'] = []
  for (const listing of enriched.slice(0, FAQ_LISTINGS)) {
    const count = random.weighted(FAQ_COUNTS)
    for (let index = 0; index < count; index += 1) {
      faqs.push({
        answer: `${listing.name} ${random.pick(['answers this in its help center', 'covers this on its pricing page', 'documents this for every plan'])}. ${random.pick(EXTRA_SENTENCES)} Contact support for anything the documentation leaves open.`,
        listingId: listing.id,
        question: (FAQ_QUESTIONS[index] as string).replace('{name}', listing.name),
        sortOrder: index
      })
    }
  }
  const resources: ScaleCatalog['resources'] = []
  for (const listing of enriched.slice(0, RESOURCE_LISTINGS)) {
    const count = random.weighted(RESOURCE_COUNTS)
    for (let index = 0; index < count; index += 1) {
      const label = RESOURCE_LABELS[index] as string
      resources.push({
        label,
        listingId: listing.id,
        sortOrder: index,
        url: `https://docs.example.org/${listing.slug}/${slugify(label)}`
      })
    }
  }

  const media: ScaleMedia[] = []
  const hosted = (
    listing: ScaleListing,
    kind: 'image' | 'logo',
    sortOrder: number,
    format: HostedImageFormat,
    [width, height]: readonly [number, number]
  ): ScaleMedia => {
    const digest = sha256(`${seed}:${listing.slug}:${kind}:${sortOrder}`)
    return {
      bytes: random.int(800, 400_000),
      contentType: IMAGE_CONTENT_TYPES[format],
      height,
      kind,
      listingId: listing.id,
      mediaKey: mediaKey({ format, kind, sha256: digest, slug: listing.slug }),
      sha256: digest,
      sortOrder,
      url: `https://assets.example.com/${listing.slug}/${kind}-${sortOrder}`,
      width
    }
  }
  for (const listing of listings) {
    if (random.chance(0.925)) {
      const side = random.pick([64, 128, 180, 256, 512] as const)
      media.push(
        hosted(listing, 'logo', 0, random.pick(['png', 'png', 'webp', 'ico'] as const), [
          side,
          side
        ])
      )
    }
    if (random.chance(0.795)) {
      const count = random.weighted(IMAGE_COUNTS)
      for (let index = 1; index <= count; index += 1) {
        media.push(
          hosted(
            listing,
            'image',
            index,
            random.pick(['png', 'jpeg', 'webp'] as const),
            [1200, 630]
          )
        )
      }
    }
    if (random.chance(0.01)) {
      media.push({
        bytes: null,
        contentType: null,
        height: null,
        kind: 'video',
        listingId: listing.id,
        mediaKey: null,
        sha256: null,
        sortOrder: 0,
        url: `https://video.example.com/watch/${listing.slug}`,
        width: null
      })
    }
  }

  // Enough redirects that a scan of them would show against the canonical-redirect budget.
  const redirects = random
    .shuffle([...liveDomains])
    .slice(0, 50)
    .map(listing => ({
      listingId: listing.id,
      newSlug: listing.slug,
      oldSlug: listing.slug.replace(/\.test$/u, '-previous.test')
    }))

  // Accounts, owners and submissions: a little of every state the account and admin pages show.
  const users = Array.from({ length: 30 }, (_, index) => {
    const number = String(index + 1).padStart(3, '0')
    return {
      email: `owner${number}@example.com`,
      id: `scale-user-${number}`,
      name: `Owner ${number}`
    }
  })
  const userIds = users.map(user => user.id)
  // A submission's slug is its website's host, so the listings it became have domain slugs.
  const fromSubmissions = random.shuffle(
    live.filter(
      listing => listing.publishedAt !== BULK_PUBLISHED_AT && listing.slug.endsWith('.test')
    )
  )
  const submissions: ScaleSubmission[] = []
  const submitted = (
    status: ScaleSubmission['status'],
    overrides: Partial<ScaleSubmission> = {}
  ): ScaleSubmission => {
    const stem = word()
    const slug = `${stem}.test`
    const day = random.int(0, 20) + 100
    return {
      badgeVerifiedAt: null,
      blockKey: slug,
      categorySlug: random.pick(topical),
      content: `## Overview\n\n${capitalize(stem)} ${random.pick(['helps', 'lets'])} ${random.pick(AUDIENCES)} ${random.pick(['ship faster', 'save time', 'stay organized'])}.`,
      createdAt: laterInstant(day),
      description: `${capitalize(stem)} for ${random.pick(AUDIENCES)}.`,
      draftSavedAt: null,
      id: random.uuid(),
      lastVerificationAt: null,
      lastVerificationError: null,
      listingId: null,
      logoUrl: `https://assets.example.com/submissions/${slug}/logo.png`,
      name: capitalize(stem),
      ownerUserId: random.pick(userIds),
      paidAt: null,
      plan: 'free',
      publishedChecksum: null,
      rejectionCategory: null,
      rejectionReason: null,
      reviewedAt: null,
      reviewedBy: null,
      reviewerNote: null,
      slug,
      status,
      verificationAttempts: 0,
      website: `https://${slug}/`,
      withdrawalReason: null,
      ...overrides
    }
  }
  const fromListing = (listing: ScaleListing): Partial<ScaleSubmission> => {
    listing.source = 'submission'
    return {
      blockKey: listing.slug,
      categorySlug: listing.categories[0] as string,
      description: listing.description,
      listingId: listing.id,
      name: listing.name,
      slug: listing.slug,
      website: `https://${listing.slug}/`
    }
  }
  const [paidA, paidB, approvedA, approvedB, approvedC] = fromSubmissions as ScaleListing[]
  submissions.push(
    submitted('draft', { draftSavedAt: laterInstant(124.2), plan: null }),
    submitted('draft', { draftSavedAt: laterInstant(122.5), plan: 'paid' }),
    submitted('pending_badge', {
      lastVerificationAt: laterInstant(121),
      lastVerificationError: 'badge_missing',
      verificationAttempts: 1
    }),
    submitted('pending_badge'),
    submitted('verified', { badgeVerifiedAt: laterInstant(119) }),
    submitted('verified', { badgeVerifiedAt: laterInstant(120.5) }),
    ...[paidA, paidB].map(listing =>
      submitted('paid_pending_review', {
        ...fromListing(listing as ScaleListing),
        paidAt: listing?.publishedAt as string,
        plan: 'paid',
        publishedChecksum: listing?.checksum as string
      })
    ),
    submitted('changes_requested', { reviewerNote: 'Add a pricing page, then resubmit.' }),
    submitted('changes_requested', { plan: 'paid', paidAt: laterInstant(110) }),
    ...[approvedA, approvedB, approvedC].map((listing, index) =>
      submitted('approved', {
        ...fromListing(listing as ScaleListing),
        paidAt: index === 0 ? (listing?.publishedAt as string) : null,
        plan: index === 0 ? 'paid' : 'free',
        reviewedAt: listing?.publishedAt as string,
        reviewedBy: ADMIN
      })
    ),
    submitted('rejected', {
      rejectionCategory: 'other',
      rejectionReason: 'The site was not reachable during review.',
      reviewedAt: laterInstant(118),
      reviewedBy: ADMIN
    }),
    submitted('rejected', {
      rejectionCategory: 'prohibited',
      rejectionReason: 'Gambling content is prohibited by the Terms.',
      reviewedAt: laterInstant(117),
      reviewedBy: ADMIN
    }),
    submitted('withdrawn', { withdrawalReason: 'owner' }),
    submitted('withdrawn', {
      draftSavedAt: laterInstant(80),
      plan: null,
      withdrawalReason: 'expired'
    })
  )
  const prohibited = submissions.find(item => item.rejectionCategory === 'prohibited')
  const urlBlocks = prohibited
    ? [
        {
          blockedAt: prohibited.reviewedAt as string,
          reason: prohibited.rejectionReason as string,
          submissionId: prohibited.id,
          urlKey: prohibited.blockKey
        }
      ]
    : []

  // Owners: approved submitters, claims, an admin grant, and transfers that revoked a holder.
  const owners: ScaleCatalog['owners'] = []
  for (const submission of submissions.filter(item => item.status === 'approved')) {
    owners.push({
      listingId: submission.listingId as string,
      revokedAt: null,
      revokedReason: null,
      userId: submission.ownerUserId,
      verifiedAt: submission.reviewedAt as string,
      verifiedVia: 'submission'
    })
  }
  const owned = new Set(owners.map(owner => owner.listingId))
  const claimed = random.shuffle(live.filter(listing => !owned.has(listing.id))).slice(0, 24)
  for (const [index, listing] of claimed.entries()) {
    const userId = userIds[index % userIds.length] as string
    if (index < 3) {
      owners.push({
        listingId: listing.id,
        revokedAt: laterInstant(115),
        revokedReason: 'Transferred by an admin.',
        userId: userIds[(index + 10) % userIds.length] as string,
        verifiedAt: laterInstant(90),
        verifiedVia: 'badge_claim'
      })
    }
    owners.push({
      listingId: listing.id,
      revokedAt: null,
      revokedReason: null,
      userId,
      verifiedAt: laterInstant(index < 3 ? 115 : 95 + index),
      verifiedVia: index < 3 ? 'admin' : index % 2 === 0 ? 'badge_claim' : 'paid_claim'
    })
  }

  const taxonomy = buildTaxonomy(
    new Random(seed + TAXONOMY_SEED_OFFSET),
    categories,
    listings,
    plans
  )

  return {
    ...taxonomy,
    categories,
    faqs,
    listings,
    media,
    owners,
    publication: {
      checksum: sha256(listings.map(listing => listing.checksum).join('\n')),
      manifestId: 'scale-catalog',
      publishedAt: laterInstant(126),
      version: 24
    },
    redirects,
    resources,
    submissions,
    urlBlocks,
    users
  }
}

/** Whether a listing is public at `asOf`, by the catalog's own rule (`publicEligibilitySql`). */
export function isPublicListing(listing: ScaleListing, asOf: string): boolean {
  return (
    listing.status === 'approved' &&
    listing.isActive &&
    listing.publishedAt !== null &&
    listing.publishedAt <= asOf
  )
}

/** Multi-row INSERTs within D1's 100 bound parameters per statement. */
function insertRows(table: string, columns: string[], rows: SqlValue[][]): SqlStatement[] {
  const perStatement = Math.floor(100 / columns.length)
  const statements: SqlStatement[] = []
  for (let start = 0; start < rows.length; start += perStatement) {
    const chunk = rows.slice(start, start + perStatement)
    const tuple = `(${columns.map(() => '?').join(',')})`
    statements.push({
      params: chunk.flat(),
      sql: `INSERT INTO ${table} (${columns.join(',')}) VALUES ${chunk.map(() => tuple).join(',')}`
    })
  }
  return statements
}

const flag = (value: boolean): number => (value ? 1 : 0)

/**
 * The statements that load `catalog` into a freshly migrated database, in an order its foreign
 * keys and triggers accept: public listings go in as drafts, get their categories, then publish,
 * as approval does. Every value is bound.
 */
export function scaleCatalogStatements(catalog: ScaleCatalog): SqlStatement[] {
  const publishing = catalog.listings.filter(
    listing => listing.status === 'approved' && listing.isActive
  )
  const publishingIds = new Set(publishing.map(listing => listing.id))
  const statements: SqlStatement[] = [
    {
      params: [
        catalog.publication.version,
        catalog.publication.manifestId,
        catalog.publication.checksum,
        catalog.publication.publishedAt
      ],
      sql: 'INSERT INTO publication_state (id,version,manifest_id,checksum,published_at) VALUES (1,?,?,?,?)'
    },
    ...insertRows(
      'categories',
      ['id', 'slug', 'name', 'description', 'sort_order', 'is_active', 'created_at', 'updated_at'],
      catalog.categories.map(category => [
        category.id,
        category.slug,
        category.name,
        category.description,
        category.sortOrder,
        flag(category.isActive),
        BULK_CREATED_AT,
        BULK_CREATED_AT
      ])
    ),
    ...insertRows(
      'users',
      ['id', 'name', 'email', 'email_verified', 'created_at', 'updated_at'],
      catalog.users.map(user => [
        user.id,
        user.name,
        user.email,
        1,
        1_780_000_000_000,
        1_780_000_000_000
      ])
    ),
    ...insertRows(
      'listings',
      [
        'id',
        'slug',
        'name',
        'description',
        'website',
        'content',
        'entity_type',
        'priority',
        'is_unofficial',
        'is_featured',
        'is_active',
        'status',
        'published_at',
        'source_kind',
        'source_identity',
        'checksum',
        'created_at',
        'updated_at',
        'display_order',
        'source',
        'link_rel'
      ],
      catalog.listings.map(listing => [
        listing.id,
        listing.slug,
        listing.name,
        listing.description,
        listing.website,
        listing.content,
        listing.entityType,
        listing.priority,
        flag(listing.isUnofficial),
        flag(listing.isFeatured),
        flag(listing.isActive),
        publishingIds.has(listing.id) ? 'draft' : listing.status,
        publishingIds.has(listing.id) ? null : listing.publishedAt,
        'scale-catalog',
        listing.slug,
        listing.checksum,
        listing.createdAt,
        listing.updatedAt,
        listing.displayOrder,
        listing.source,
        listing.linkRel
      ])
    )
  ]
  const categoryIds = new Map(catalog.categories.map(category => [category.slug, category.id]))
  statements.push(
    ...insertRows(
      'listing_categories',
      ['listing_id', 'category_id', 'sort_order', 'is_primary'],
      catalog.listings.flatMap(listing =>
        listing.categories.map((slug, index) => [
          listing.id,
          categoryIds.get(slug) as number,
          index,
          flag(index === 0)
        ])
      )
    )
  )
  const byDate = new Map<string, string[]>()
  for (const listing of publishing) {
    const date = listing.publishedAt as string
    byDate.set(date, [...(byDate.get(date) ?? []), listing.id])
  }
  for (const [date, ids] of [...byDate].sort(([left], [right]) => byCodeUnit(left, right))) {
    for (let start = 0; start < ids.length; start += 500) {
      statements.push({
        params: [date, JSON.stringify(ids.slice(start, start + 500))],
        sql: "UPDATE listings SET status='approved', published_at=? WHERE id IN (SELECT value FROM json_each(?))"
      })
    }
  }
  statements.push(
    ...insertRows(
      'listing_media',
      [
        'listing_id',
        'kind',
        'url',
        'sort_order',
        'media_key',
        'sha256',
        'content_type',
        'bytes',
        'width',
        'height'
      ],
      catalog.media.map(item => [
        item.listingId,
        item.kind,
        item.url,
        item.sortOrder,
        item.mediaKey,
        item.sha256,
        item.contentType,
        item.bytes,
        item.width,
        item.height
      ])
    ),
    ...insertRows(
      'listing_faqs',
      ['listing_id', 'question', 'answer', 'sort_order'],
      catalog.faqs.map(faq => [faq.listingId, faq.question, faq.answer, faq.sortOrder])
    ),
    ...insertRows(
      'listing_resource_links',
      ['listing_id', 'label', 'url', 'sort_order'],
      catalog.resources.map(link => [link.listingId, link.label, link.url, link.sortOrder])
    ),
    ...insertRows(
      'listing_slug_redirects',
      ['listing_id', 'old_slug', 'new_slug', 'manifest_id', 'reason', 'created_at'],
      catalog.redirects.map(redirect => [
        redirect.listingId,
        redirect.oldSlug,
        redirect.newSlug,
        'scale-catalog-renames',
        'Renamed to its own domain.',
        BULK_CREATED_AT
      ])
    ),
    ...insertRows(
      'listing_owners',
      ['listing_id', 'user_id', 'verified_via', 'verified_at', 'revoked_at', 'revoked_reason'],
      catalog.owners.map(owner => [
        owner.listingId,
        owner.userId,
        owner.verifiedVia,
        owner.verifiedAt,
        owner.revokedAt,
        owner.revokedReason
      ])
    ),
    ...insertRows(
      'listing_submissions',
      [
        'id',
        'slug',
        'name',
        'description',
        'website',
        'content',
        'category_slug',
        'logo_url',
        'status',
        'verification_attempts',
        'last_verification_at',
        'last_verification_error',
        'badge_verified_at',
        'reviewed_at',
        'reviewed_by',
        'listing_id',
        'created_at',
        'updated_at',
        'owner_user_id',
        'plan',
        'paid_at',
        'reviewer_note',
        'rejection_reason',
        'rejection_category',
        'draft_saved_at',
        'withdrawal_reason',
        'block_key',
        'block_covers_subdomains',
        'published_checksum'
      ],
      catalog.submissions.map(item => [
        item.id,
        item.slug,
        item.name,
        item.description,
        item.website,
        item.content,
        item.categorySlug,
        item.logoUrl,
        item.status,
        item.verificationAttempts,
        item.lastVerificationAt,
        item.lastVerificationError,
        item.badgeVerifiedAt,
        item.reviewedAt,
        item.reviewedBy,
        item.listingId,
        item.createdAt,
        item.createdAt,
        item.ownerUserId,
        item.plan,
        item.paidAt,
        item.reviewerNote,
        item.rejectionReason,
        item.rejectionCategory,
        item.draftSavedAt,
        item.withdrawalReason,
        item.blockKey,
        1,
        item.publishedChecksum
      ])
    ),
    ...insertRows(
      'listing_submission_url_blocks',
      ['url_key', 'submission_id', 'reason', 'blocked_by', 'blocked_at', 'covers_subdomains'],
      catalog.urlBlocks.map(block => [
        block.urlKey,
        block.submissionId,
        block.reason,
        ADMIN,
        block.blockedAt,
        1
      ])
    )
  )
  statements.push(...taxonomyStatements(catalog, categoryIds))
  return statements
}

/**
 * The taxonomy's rows (#341): every tag goes in active, its memberships follow, then the retired
 * ones retire, as a retired tag keeps its listings but takes no new one.
 */
function taxonomyStatements(
  catalog: ScaleCatalog,
  categoryIds: Map<string, number>
): SqlStatement[] {
  const tagIds = new Map(catalog.tags.map(tag => [tag.slug, tag.id]))
  const bestPageIds = new Map(catalog.bestPages.map(page => [page.slug, page.id]))
  const idOf = (ids: Map<string, number>, slug: string | null) =>
    slug === null ? null : (ids.get(slug) as number)
  const target = (redirect: ScaleTaxonomyRedirect, kind: ScaleTaxonomyRedirect['targetKind']) =>
    redirect.targetKind === kind ? redirect.targetSlug : null
  return [
    ...insertRows(
      'tags',
      [
        'id',
        'slug',
        'name',
        'description',
        'category_id',
        'sort_order',
        'is_active',
        'created_at',
        'updated_at'
      ],
      catalog.tags.map(tag => [
        tag.id,
        tag.slug,
        tag.name,
        tag.description,
        categoryIds.get(tag.categorySlug) as number,
        tag.sortOrder,
        1,
        BULK_CREATED_AT,
        BULK_CREATED_AT
      ])
    ),
    ...insertRows(
      'listing_tags',
      ['listing_id', 'tag_id', 'sort_order'],
      catalog.listings.flatMap(listing =>
        listing.tags.map((slug, index) => [listing.id, tagIds.get(slug) as number, index])
      )
    ),
    {
      params: [JSON.stringify(catalog.tags.filter(tag => !tag.isActive).map(tag => tag.id))],
      sql: 'UPDATE tags SET is_active=0 WHERE id IN (SELECT value FROM json_each(?))'
    },
    ...insertRows(
      'best_pages',
      [
        'id',
        'slug',
        'keyword',
        'title',
        'heading',
        'intro',
        'tag_id',
        'category_id',
        'list_size',
        'keyword_volume',
        'keyword_checked_at',
        'sort_order',
        'created_at',
        'updated_at'
      ],
      catalog.bestPages.map(page => [
        page.id,
        page.slug,
        page.keyword,
        page.title,
        page.title,
        page.intro,
        idOf(tagIds, page.tagSlug),
        idOf(categoryIds, page.categorySlug),
        page.listSize,
        page.keywordVolume,
        page.keywordCheckedAt,
        page.sortOrder,
        BULK_CREATED_AT,
        BULK_CREATED_AT
      ])
    ),
    ...insertRows(
      'best_page_listings',
      ['best_page_id', 'listing_id', 'position', 'excluded', 'blurb'],
      catalog.bestPageEntries.map(entry => [
        entry.bestPageId,
        entry.listingId,
        entry.position,
        flag(entry.excluded),
        entry.blurb
      ])
    ),
    ...insertRows(
      'taxonomy_redirects',
      [
        'source_kind',
        'source_slug',
        'target_kind',
        'target_category_id',
        'target_tag_id',
        'target_best_page_id',
        'manifest_id',
        'created_at'
      ],
      catalog.taxonomyRedirects.map(redirect => [
        redirect.sourceKind,
        redirect.sourceSlug,
        redirect.targetKind,
        idOf(categoryIds, target(redirect, 'category')),
        idOf(tagIds, target(redirect, 'tag')),
        idOf(bestPageIds, target(redirect, 'best')),
        TAXONOMY_MANIFEST,
        BULK_CREATED_AT
      ])
    )
  ]
}

/**
 * What the fixture seed (`pnpm db:seed:local`, serpcompany/best.serp.co#312) writes, as tests
 * assert it: slugs, names, counts, and the fixture users. The rows themselves are built in
 * `fixture-seed.ts`; `scripts/d1-local-seed.test.ts` checks that they match these facts, and
 * `pnpm db:verify:local` checks a seeded local D1 against them. The values are written out, not
 * derived from the rows, so a change to the seed fails a test instead of moving the expectation.
 *
 * Everything here is fake: listing names start with "Fixture", websites are on `.test` hosts,
 * and people are `@example.com` addresses. Times are fixed (`SEED_NOW`), so re-running the seed
 * writes the same rows; time-based states (a badge warning, a draft's clock) are as of that day.
 * The app reads the real clock, so a relative time it shows for a seeded row ("expires in 3 days",
 * "2 days ago") changes from day to day: specs never assert one (#313).
 */

/** The `migration_runs` id and manifest identity that mark a local D1 as seeded. */
export const SEED_ID = 'best-serp-co-fixtures'

/** The seed's clock: every timestamp it writes is this instant or earlier. */
export const SEED_NOW = '2026-10-08T12:00:00.000Z'

/** Where the fixture logos and images come from (answered in memory, never fetched). */
export const SEED_MEDIA_ORIGIN = 'https://fixtures.best-serp-co.test'

export const seedUsers = {
  /** On the admin allowlist: signs in to `/admin`. */
  admin: { email: 'admin@example.com', id: 'fixture-user-admin', name: 'Fixture Admin' },
  /** Has a submission in every status, two live listings, and a pending revision. */
  submitter: {
    email: 'submitter@example.com',
    id: 'fixture-user-submitter',
    name: 'Fixture Submitter'
  },
  /** Owns `seedListings.owned` through a badge claim, and lost `ownerRemoved`'s. */
  owner: { email: 'owner@example.com', id: 'fixture-user-owner', name: 'Fixture Owner' }
} as const

export const seedCategories = {
  /** 49 published listings: two directory pages of 48. */
  writing: { name: 'Writing Tools', slug: 'writing-tools' },
  design: { name: 'Design Tools', slug: 'design-tools' },
  developer: { name: 'Developer Tools', slug: 'developer-tools' },
  /** Active, with no listing: left out of the index, and its page answers 404. */
  empty: { name: 'Audio Tools', slug: 'audio-tools' }
} as const

export const seedListings = {
  /**
   * Hosted logo and featured image, content, FAQs, resource links (`seedResourceLinks`);
   * featured, with no owner. The e2e suite's sample listing, in its sample category.
   */
  detail: { category: seedCategories.design, name: 'Fixture Studio', slug: 'fixture-studio' },
  /** No logo: cards and the page show the fallback tile. Marked unofficial. */
  noLogo: { name: 'Fixture Doodlewick', slug: 'fixture-doodlewick' },
  /** No owner and no claim hold: the page offers a claim. Featured. */
  claimable: { name: 'Fixture Canvas', slug: 'fixture-canvas' },
  /** Its instant claim is held for review (`listing_claim_holds`). */
  held: { name: 'Fixture Quaybin', slug: 'fixture-quaybin' },
  /**
   * A Verified owner (`seedUsers.owner`, badge claim) in a badge warning, with a revision in
   * every closed status and one awaiting changes.
   */
  owned: { name: 'Fixture Ledger', slug: 'fixture-ledger' },
  /** Live; the badge program removed its badge-claim owner after a confirmed miss. */
  ownerRemoved: { name: 'Fixture Relay', slug: 'fixture-relay' },
  /** Approved free submission, owned by the submitter, badge passing, a revision pending. */
  submitted: { name: 'Fixture Inkwell', slug: 'inkwell.test' },
  /** Paid submission, live while it waits for review (`paid_pending_review`). */
  paid: { name: 'Fixture Parchment', slug: 'parchment.test' },
  /** Unpublished by the badge program after a confirmed miss: its page answers 410 Gone. */
  unlisted: { name: 'Fixture Scribe', slug: 'scribe.test' },
  /** Never published: its page answers 404. */
  draft: { name: 'Fixture Draft', slug: 'fixture-draft' }
} as const

/** `seedListings.detail`'s resource links, in order; each opens in a new tab. */
export const seedResourceLinks = [
  { label: 'Documentation', url: 'https://docs.fixture-studio.test/' },
  { label: 'Pricing', url: 'https://fixture-studio.test/pricing/' }
] as const

/**
 * A seeded listing's or submission's website: `https://<slug>/` when the slug is a `.test` host,
 * else `https://<slug>.test/`.
 */
export function seedWebsite(slug: string): string {
  return `https://${slug.endsWith('.test') ? slug : `${slug}.test`}/`
}

/** The filler listings that make `seedCategories.writing` paginate. */
export const seedFillerListings = {
  count: 47,
  first: { name: 'Fixture Writer 01', slug: 'fixture-writer-01' },
  last: { name: 'Fixture Writer 47', slug: 'fixture-writer-47' }
} as const

/** One submission per status (`approved` twice: the submitted and the unlisted listing). */
export const seedSubmissions = {
  draft: { id: 'fixture-submission-draft', name: 'Fixture Quire', slug: 'quire.test' },
  pending_badge: {
    id: 'fixture-submission-pending-badge',
    name: 'Fixture Folio',
    slug: 'folio.test'
  },
  verified: { id: 'fixture-submission-verified', name: 'Fixture Margin', slug: 'margin.test' },
  paid_pending_review: {
    id: 'fixture-submission-paid',
    name: seedListings.paid.name,
    slug: seedListings.paid.slug
  },
  changes_requested: {
    id: 'fixture-submission-changes',
    name: 'Fixture Vellum',
    slug: 'vellum.test'
  },
  approved: {
    id: 'fixture-submission-approved',
    name: seedListings.submitted.name,
    slug: seedListings.submitted.slug
  },
  rejected: { id: 'fixture-submission-rejected', name: 'Fixture Smudge', slug: 'smudge.test' },
  withdrawn: { id: 'fixture-submission-withdrawn', name: 'Fixture Blotter', slug: 'blotter.test' }
} as const

/** One owner revision per status: the pending one on `submitted`, the rest on `owned`. */
export const seedRevisions = {
  pending_review: { id: 'fixture-revision-pending', listing: seedListings.submitted.slug },
  changes_requested: { id: 'fixture-revision-changes', listing: seedListings.owned.slug },
  approved: { id: 'fixture-revision-approved', listing: seedListings.owned.slug },
  rejected: { id: 'fixture-revision-rejected', listing: seedListings.owned.slug },
  withdrawn: { id: 'fixture-revision-withdrawn', listing: seedListings.owned.slug }
} as const

/**
 * The three-layer taxonomy (#341): tags under the seed's categories (its hubs), best pages, and
 * redirects of old taxonomy URLs. Nothing reads them yet (#343). `listingCount` counts a tag's
 * published listings; `scribe.test` (unpublished) keeps its tag too.
 */
export const seedTags = {
  /** Fixture Inkwell and Fixture Writer 01 to 11. */
  noteTaking: {
    category: seedCategories.writing,
    listingCount: 12,
    name: 'Note Taking',
    slug: 'note-taking'
  },
  /** Fixture Parchment, Fixture Inkwell (its second tag) and Fixture Writer 12. */
  documentEditors: {
    category: seedCategories.writing,
    listingCount: 3,
    name: 'Document Editors',
    slug: 'document-editors'
  },
  /** Fixture Canvas and Fixture Doodlewick. */
  whiteboards: {
    category: seedCategories.design,
    listingCount: 2,
    name: 'Whiteboards',
    slug: 'whiteboards'
  },
  /** Fixture Studio and Fixture Canvas (its second tag). */
  mockups: {
    category: seedCategories.design,
    listingCount: 2,
    name: 'Mockup Tools',
    slug: 'mockup-tools'
  },
  /** Fixture Quaybin, Fixture Ledger and Fixture Relay. */
  apis: {
    category: seedCategories.developer,
    listingCount: 3,
    name: 'Developer APIs',
    slug: 'developer-apis'
  },
  /** Active, with no listing, on the empty category. */
  empty: {
    category: seedCategories.empty,
    listingCount: 0,
    name: 'Podcast Editing',
    slug: 'podcast-editing'
  },
  /** Retired after Fixture Writer 01 and 02 were tagged with it: they keep the membership. */
  retired: {
    category: seedCategories.writing,
    listingCount: 2,
    name: 'Outlining',
    slug: 'outlining'
  }
} as const

/** Best pages, each with its pins in position order and its exclusions. */
export const seedBestPages = {
  /** On a tag only. */
  tag: {
    category: null,
    excluded: [{ name: 'Fixture Writer 11', slug: 'fixture-writer-11' }],
    keyword: 'note taking app',
    pins: [seedListings.submitted, { name: 'Fixture Writer 03', slug: 'fixture-writer-03' }],
    slug: 'note-taking-app',
    tag: seedTags.noteTaking
  },
  /** On a category only. */
  category: {
    category: seedCategories.design,
    excluded: [],
    keyword: 'design app',
    pins: [seedListings.detail],
    slug: 'design-app',
    tag: null
  },
  /** On a tag within a category. */
  intersection: {
    category: seedCategories.design,
    excluded: [],
    keyword: 'whiteboard app',
    pins: [],
    slug: 'whiteboard-app',
    tag: seedTags.whiteboards
  }
} as const

/** Old taxonomy URLs and where they point (`taxonomy_redirects`). */
export const seedTaxonomyRedirects = [
  { from: { kind: 'category', slug: 'notebooks' }, to: { kind: 'tag', slug: 'note-taking' } },
  { from: { kind: 'category', slug: 'note-apps' }, to: { kind: 'best', slug: 'note-taking-app' } },
  {
    from: { kind: 'category', slug: 'drawing-tools' },
    to: { kind: 'category', slug: 'design-tools' }
  },
  { from: { kind: 'category', slug: 'misc-tools' }, to: { kind: 'directory', slug: null } },
  { from: { kind: 'tag', slug: 'whiteboarding' }, to: { kind: 'tag', slug: 'whiteboards' } },
  {
    from: { kind: 'best', slug: 'whiteboard-tools' },
    to: { kind: 'best', slug: 'whiteboard-app' }
  },
  // Targets with nothing to show (the empty category and tag): these URLs answer 404, not a 308
  // to a 404 (#346 review).
  {
    from: { kind: 'category', slug: 'sound-tools' },
    to: { kind: 'category', slug: seedCategories.empty.slug }
  },
  { from: { kind: 'category', slug: 'podcasts' }, to: { kind: 'tag', slug: seedTags.empty.slug } }
] as const

export const seedFacts = {
  /** Published listings: the directory total, RSS, and the products sitemap. */
  listingCount: 55,
  /** Categories with a published listing (the index and the categories sitemap). */
  categoryCount: 3,
  paginatedCategory: { ...seedCategories.writing, listingCount: 49, pageCount: 2 },
  emptyCategory: seedCategories.empty,
  featuredCount: 2,
  /** Published listings with a hosted logo: all but `seedListings.noLogo`. */
  hostedLogoCount: 54,
  /** Published listings with a hosted featured image. */
  hostedImageCount: 1,
  /** A query that matches exactly these published listings (name, description, or slug). */
  search: { query: 'quaybin', listings: [seedListings.held] }
} as const

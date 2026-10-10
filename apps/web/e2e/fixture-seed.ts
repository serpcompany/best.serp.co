import {
  SEED_ID,
  SEED_MEDIA_ORIGIN,
  SEED_NOW,
  seedBestPages,
  seedCategories,
  seedFillerListings,
  seedListings,
  seedResourceLinks,
  seedRevisions,
  seedSubmissions,
  seedTags,
  seedTaxonomyRedirects,
  seedUsers,
  seedWebsite
} from './seed-facts'

/**
 * The fixture seed's rows (serpcompany/best.serp.co#312), facts in `seed-facts.ts`. A listing is
 * inserted as a draft, filed under its primary category, then published, so the publication
 * triggers hold (`listingStatements`, which the e2e suites that seed their own D1s use too, with
 * `suiteCatalogStatements`, #313). Every value is a bound parameter. `pnpm db:seed:local`
 * (`scripts/d1-local-seed.ts`) runs these statements in one D1 batch on a freshly migrated local
 * D1, then hosts `fixtureSeedImages()` through the real media ingestion path. The statements are
 * deterministic: the same rows on every run.
 */

export type SeedValue = number | string | null

export interface SeedStatement {
  params: SeedValue[]
  sql: string
}

/** A generated PNG the seed hosts on a listing (logo or featured image). */
export interface SeedImage {
  height: number
  kind: 'image' | 'logo'
  listingId: string
  rgb: [number, number, number]
  sourceUrl: string
  width: number
}

export type ListingState = 'draft' | 'published' | 'unpublished'

interface ListingDefinition {
  category: string
  content: string
  description: string
  faqs?: Array<{ answer: string; question: string }>
  featured?: boolean
  /** Hosts a featured image too. */
  image?: boolean
  logo: boolean
  name: string
  /** Days before `SEED_NOW`; null for a listing never published. */
  publishedDaysAgo: number | null
  resourceLinks?: Array<{ label: string; url: string }>
  slug: string
  state: ListingState
  /** The approved submission it came from (`source = 'submission'`). */
  submissionId?: string
  unofficial?: boolean
}

const DAY_MS = 24 * 60 * 60 * 1000
/** The badge program's actor (`BADGE_PROGRAM_ACTOR` in `apps/web/src/db/badge-program.ts`). */
const BADGE_PROGRAM_ACTOR = 'badge-program'
const UNLISTED_SUBMISSION_ID = 'fixture-submission-unlisted'

/** An ISO instant `days` before `SEED_NOW`. */
export function seedTime(days: number): string {
  return new Date(Date.parse(SEED_NOW) - days * DAY_MS).toISOString()
}

/** A listing id as the app accepts one in a URL (`[A-Za-z0-9_-]`, `ACCOUNT_ID`). */
export function seedListingId(slug: string): string {
  return `fixture-listing-${slug.replaceAll('.', '-')}`
}

function listingChecksum(slug: string): string {
  return `fixture-${slug}-v1`
}

/** The listing's hosted logo source, which an owner's revision keeps. */
function logoSource(slug: string): string {
  return `${SEED_MEDIA_ORIGIN}/logos/${slug}.png`
}

/** One row, every value bound. `INSERT OR IGNORE` for a row each worker's `beforeAll` writes. */
export function insert(
  table: string,
  row: Record<string, SeedValue>,
  verb: 'INSERT' | 'INSERT OR IGNORE' = 'INSERT'
): SeedStatement {
  const columns = Object.keys(row)
  return {
    sql: `${verb} INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
    params: Object.values(row)
  }
}

/**
 * A listing the catalog's triggers accept: `row` inserted as a draft, filed under its primary
 * `category`, then, unless `state` is `draft`, approved and published (or left unpublished).
 * `beforeApproval` runs between filing and approval: media or FAQs present when it goes live.
 */
export function listingStatements(listing: {
  beforeApproval?: SeedStatement[]
  category: string
  row: Record<string, SeedValue> & { id: string }
  state?: ListingState
}): SeedStatement[] {
  const { beforeApproval = [], category, row, state = 'published' } = listing
  return [
    insert('listings', { ...row, status: 'draft' }),
    {
      sql: `INSERT INTO listing_categories (listing_id,category_id,sort_order,is_primary)
          SELECT ?,id,0,1 FROM categories WHERE slug=?`,
      params: [row.id, category]
    },
    ...beforeApproval,
    ...(state === 'draft'
      ? []
      : [
          {
            sql: `UPDATE listings SET status='approved',is_active=? WHERE id=?`,
            params: [state === 'published' ? 1 : 0, row.id]
          }
        ])
  ]
}

/**
 * The catalog rows an e2e suite's own fresh D1 starts from (`admin-fixture.ts`; the badge,
 * claims and orders suites): the publication state and the suite's category, as the seed writes
 * its own. Each Playwright worker's `beforeAll` writes them, so a second write is ignored.
 */
export function suiteCatalogStatements(suite: {
  category: { description: string; name: string; slug: string }
  checksum: string
}): SeedStatement[] {
  return [
    insert(
      'publication_state',
      { checksum: suite.checksum, id: 1, version: 0 },
      'INSERT OR IGNORE'
    ),
    insert('categories', { ...suite.category, sort_order: 0 }, 'INSERT OR IGNORE')
  ]
}

const namedListings: ListingDefinition[] = [
  {
    ...seedListings.detail,
    category: seedListings.detail.category.slug,
    content:
      'Fixture Studio is a made-up design tool that exists only in the local fixture seed.\n\n' +
      '## What this page shows\n\nA hosted logo and featured image, FAQs, and resource links.',
    description: 'A fixture design studio for layouts and mockups.',
    faqs: [
      {
        answer: 'No. It is fixture data for local development and tests.',
        question: 'Is Fixture Studio a real product?'
      },
      {
        answer: 'The seed hosts a generated PNG through the real media ingestion path.',
        question: 'Where does its logo come from?'
      }
    ],
    featured: true,
    image: true,
    logo: true,
    publishedDaysAgo: 1,
    resourceLinks: [...seedResourceLinks],
    state: 'published'
  },
  {
    ...seedListings.claimable,
    category: seedCategories.design.slug,
    content: 'Fixture Canvas has no owner yet, so its page offers a claim.',
    description: 'A fixture whiteboard for sketching ideas together.',
    featured: true,
    logo: true,
    publishedDaysAgo: 2,
    state: 'published'
  },
  {
    ...seedListings.noLogo,
    category: seedCategories.design.slug,
    content: 'Fixture Doodlewick has no logo, so it shows the fallback tile.',
    description: 'A fixture drawing pad with no logo of its own.',
    logo: false,
    publishedDaysAgo: 3,
    state: 'published',
    unofficial: true
  },
  {
    ...seedListings.held,
    category: seedCategories.developer.slug,
    content: 'Claims of Fixture Quaybin wait for an admin to review them.',
    description: 'A fixture container registry whose claims are held for review.',
    logo: true,
    publishedDaysAgo: 4,
    state: 'published'
  },
  {
    ...seedListings.owned,
    category: seedCategories.developer.slug,
    content: 'Fixture Ledger is owned through a badge claim and is in a badge warning.',
    description: 'A fixture bookkeeping API with a verified owner.',
    logo: true,
    publishedDaysAgo: 5,
    state: 'published'
  },
  {
    ...seedListings.ownerRemoved,
    category: seedCategories.developer.slug,
    content: 'The badge program removed the owner of Fixture Relay after a confirmed miss.',
    description: 'A fixture webhook relay that lost its owner.',
    logo: true,
    publishedDaysAgo: 6,
    state: 'published'
  },
  {
    ...seedListings.submitted,
    category: seedCategories.writing.slug,
    content: 'Fixture Inkwell came from an approved free submission.',
    description: 'A fixture notebook submitted on the free plan.',
    logo: true,
    publishedDaysAgo: 7,
    state: 'published',
    submissionId: seedSubmissions.approved.id
  },
  {
    ...seedListings.paid,
    category: seedCategories.writing.slug,
    content: 'Fixture Parchment is live while its paid submission waits for review.',
    description: 'A fixture document editor submitted on the paid plan.',
    logo: true,
    publishedDaysAgo: 0.5,
    state: 'published',
    submissionId: seedSubmissions.paid_pending_review.id
  },
  {
    ...seedListings.unlisted,
    category: seedCategories.writing.slug,
    content: 'The badge program unlisted Fixture Scribe after a confirmed miss.',
    description: 'A fixture transcription tool that was unlisted.',
    logo: false,
    publishedDaysAgo: 20,
    state: 'unpublished',
    submissionId: UNLISTED_SUBMISSION_ID
  },
  {
    ...seedListings.draft,
    category: seedCategories.writing.slug,
    content: 'Fixture Draft was never published.',
    description: 'A fixture listing that was never published.',
    logo: false,
    publishedDaysAgo: null,
    state: 'draft'
  }
]

function fillerListings(): ListingDefinition[] {
  return Array.from({ length: seedFillerListings.count }, (_, index) => {
    const number = String(index + 1).padStart(2, '0')
    return {
      category: seedCategories.writing.slug,
      content: `Fixture Writer ${number} fills the writing category past one directory page.`,
      description: `Fixture writing tool number ${number}.`,
      logo: true,
      name: `Fixture Writer ${number}`,
      publishedDaysAgo: 10 + index,
      slug: `fixture-writer-${number}`,
      state: 'published' as const
    }
  })
}

/** Every listing the seed writes, in display order. */
export function fixtureSeedListings(): readonly ListingDefinition[] {
  return [...namedListings, ...fillerListings()]
}

/** Distinct, fixed logo colors. */
const PALETTE: Array<[number, number, number]> = [
  [16, 185, 129],
  [59, 130, 246],
  [234, 88, 12],
  [139, 92, 246],
  [236, 72, 153],
  [20, 184, 166],
  [202, 138, 4],
  [100, 116, 139]
]

/** The images the seed hosts, in order: each listed listing's logo, then featured images. */
export function fixtureSeedImages(): SeedImage[] {
  const listings = fixtureSeedListings()
  const color = (index: number) => PALETTE[index % PALETTE.length] as [number, number, number]
  return [
    ...listings.flatMap((listing, index) =>
      listing.logo
        ? [
            {
              height: 512,
              kind: 'logo' as const,
              listingId: seedListingId(listing.slug),
              rgb: color(index),
              sourceUrl: logoSource(listing.slug),
              width: 512
            }
          ]
        : []
    ),
    ...listings.flatMap((listing, index) =>
      listing.image
        ? [
            {
              height: 630,
              kind: 'image' as const,
              listingId: seedListingId(listing.slug),
              rgb: color(index + 3),
              sourceUrl: `${SEED_MEDIA_ORIGIN}/images/${listing.slug}.png`,
              width: 1200
            }
          ]
        : []
    )
  ]
}

function catalogStatements(): SeedStatement[] {
  const categories = Object.values(seedCategories).map((category, index) =>
    insert('categories', {
      created_at: seedTime(60),
      description: `${category.name} in the local fixture seed.`,
      id: index + 1,
      is_active: 1,
      name: category.name,
      slug: category.slug,
      sort_order: index,
      updated_at: seedTime(60)
    })
  )
  const listings = fixtureSeedListings().flatMap((listing, index) => {
    const id = seedListingId(listing.slug)
    const publishedAt =
      listing.publishedDaysAgo === null ? null : seedTime(listing.publishedDaysAgo)
    const statements = listingStatements({
      category: listing.category,
      row: {
        checksum: listingChecksum(listing.slug),
        content: listing.content,
        created_at: publishedAt ?? seedTime(1),
        description: listing.description,
        display_order: index,
        id,
        is_active: 1,
        is_featured: listing.featured ? 1 : 0,
        is_unofficial: listing.unofficial ? 1 : 0,
        link_rel: listing.submissionId ? 'nofollow' : 'follow',
        name: listing.name,
        published_at: publishedAt,
        slug: listing.slug,
        source: listing.submissionId ? 'submission' : 'admin',
        source_identity: listing.submissionId ?? listing.slug,
        source_kind: listing.submissionId ? 'verified-submission' : 'fixture-seed',
        status: 'draft',
        updated_at: publishedAt ?? seedTime(1),
        website: seedWebsite(listing.slug)
      },
      state: listing.state
    })
    for (const [sortOrder, faq] of (listing.faqs ?? []).entries()) {
      statements.push(
        insert('listing_faqs', {
          answer: faq.answer,
          listing_id: id,
          question: faq.question,
          sort_order: sortOrder
        })
      )
    }
    for (const [sortOrder, link] of (listing.resourceLinks ?? []).entries()) {
      statements.push(
        insert('listing_resource_links', {
          label: link.label,
          listing_id: id,
          sort_order: sortOrder,
          url: link.url
        })
      )
    }
    return statements
  })
  return [
    insert('publication_state', {
      checksum: `${SEED_ID}-v0`,
      id: 1,
      manifest_id: SEED_ID,
      published_at: seedTime(60),
      version: 0
    }),
    ...categories,
    ...listings
  ]
}

function userStatements(): SeedStatement[] {
  const createdAt = Date.parse(seedTime(30))
  return [
    ...Object.values(seedUsers).map(user =>
      insert('users', {
        created_at: createdAt,
        email: user.email,
        email_verified: 1,
        id: user.id,
        name: user.name,
        role: user.id === seedUsers.admin.id ? 'admin' : 'user',
        updated_at: createdAt
      })
    ),
    insert('admin_allowlist', {
      added_by: SEED_ID,
      created_at: seedTime(30),
      email: seedUsers.admin.email,
      note: 'Fixture admin'
    })
  ]
}

interface SubmissionDefinition {
  created: number
  events: Array<{ actor?: string; at: number; detail?: string; type: string }>
  fields: Record<string, SeedValue>
  id: string
  name: string
  slug: string
  status: string
}

function submissionDefinitions(): SubmissionDefinition[] {
  const reviewer = seedUsers.admin.email
  const reviewed = (days: number) => ({ reviewed_at: seedTime(days), reviewed_by: reviewer })
  return [
    {
      ...seedSubmissions.draft,
      created: 2,
      events: [{ at: 2, type: 'created' }],
      fields: { draft_saved_at: seedTime(2), plan: null },
      status: 'draft'
    },
    {
      ...seedSubmissions.pending_badge,
      created: 4,
      events: [{ at: 3, detail: 'badge_missing', type: 'verification_failed' }],
      fields: {
        last_verification_at: seedTime(3),
        last_verification_error: 'badge_missing',
        verification_attempts: 1
      },
      status: 'pending_badge'
    },
    {
      ...seedSubmissions.verified,
      created: 5,
      events: [{ at: 3, type: 'badge_verified' }],
      fields: { badge_verified_at: seedTime(3), verification_attempts: 1 },
      status: 'verified'
    },
    {
      ...seedSubmissions.paid_pending_review,
      created: 1,
      events: [{ at: 0.5, detail: 'published', type: 'paid' }],
      fields: {
        listing_id: seedListingId(seedSubmissions.paid_pending_review.slug),
        paid_at: seedTime(0.5),
        plan: 'paid',
        published_checksum: listingChecksum(seedSubmissions.paid_pending_review.slug)
      },
      status: 'paid_pending_review'
    },
    {
      ...seedSubmissions.changes_requested,
      created: 6,
      events: [
        {
          actor: reviewer,
          at: 4,
          detail: 'Say what the product does in the first sentence.',
          type: 'changes_requested'
        }
      ],
      fields: {
        badge_verified_at: seedTime(5.5),
        reviewer_note: 'Say what the product does in the first sentence.',
        verification_attempts: 1,
        ...reviewed(4)
      },
      status: 'changes_requested'
    },
    {
      ...seedSubmissions.approved,
      created: 9,
      events: [{ actor: reviewer, at: 7, type: 'approved' }],
      fields: {
        badge_verified_at: seedTime(8.5),
        listing_id: seedListingId(seedSubmissions.approved.slug),
        verification_attempts: 1,
        ...reviewed(7)
      },
      status: 'approved'
    },
    {
      ...seedListings.unlisted,
      created: 22,
      events: [
        { actor: reviewer, at: 20, type: 'approved' },
        { actor: BADGE_PROGRAM_ACTOR, at: 9, detail: 'badge_missing', type: 'unpublished' }
      ],
      fields: {
        badge_verified_at: seedTime(21.5),
        listing_id: seedListingId(seedListings.unlisted.slug),
        verification_attempts: 1,
        ...reviewed(20)
      },
      id: UNLISTED_SUBMISSION_ID,
      status: 'approved'
    },
    {
      ...seedSubmissions.rejected,
      created: 8,
      events: [{ actor: reviewer, at: 6, type: 'rejected' }],
      fields: {
        badge_verified_at: seedTime(7.5),
        rejection_category: 'other',
        rejection_reason: 'The site does not describe a software product.',
        verification_attempts: 1,
        ...reviewed(6)
      },
      status: 'rejected'
    },
    {
      ...seedSubmissions.withdrawn,
      created: 10,
      events: [{ at: 9, type: 'withdrawn' }],
      fields: { withdrawal_reason: 'owner' },
      status: 'withdrawn'
    }
  ]
}

function submissionStatements(): SeedStatement[] {
  const submitter = seedUsers.submitter.id
  return submissionDefinitions().flatMap(submission => {
    const lastEvent = Math.min(...submission.events.map(event => event.at))
    return [
      insert('listing_submissions', {
        block_covers_subdomains: 1,
        block_key: submission.slug,
        category_slug: seedCategories.writing.slug,
        content: `${submission.name} is a fixture submission from the local seed.`,
        created_at: seedTime(submission.created),
        description: `A fixture submission (${submission.status.replaceAll('_', ' ')}).`,
        id: submission.id,
        logo_url: `${seedWebsite(submission.slug)}logo.png`,
        name: submission.name,
        owner_user_id: submitter,
        plan: 'free',
        slug: submission.slug,
        status: submission.status,
        updated_at: seedTime(lastEvent),
        website: seedWebsite(submission.slug),
        ...submission.fields
      }),
      ...submission.events.map(event =>
        insert('listing_submission_events', {
          actor: event.actor ?? submitter,
          created_at: seedTime(event.at),
          detail: event.detail ?? null,
          event_type: event.type,
          submission_id: submission.id
        })
      )
    ]
  })
}

function ownershipStatements(): SeedStatement[] {
  const owned = (slug: string, user: string, via: string, days: number) =>
    insert('listing_owners', {
      created_at: seedTime(days),
      listing_id: seedListingId(slug),
      role: 'owner',
      user_id: user,
      verified_at: seedTime(days),
      verified_via: via
    })
  const submitter = seedUsers.submitter.id
  const owner = seedUsers.owner.id
  return [
    owned(seedListings.submitted.slug, submitter, 'submission', 7),
    owned(seedListings.paid.slug, submitter, 'submission', 0.5),
    owned(seedListings.unlisted.slug, submitter, 'submission', 20),
    owned(seedListings.owned.slug, owner, 'badge_claim', 15),
    insert('listing_owners', {
      created_at: seedTime(15),
      listing_id: seedListingId(seedListings.ownerRemoved.slug),
      revoked_at: seedTime(9),
      revoked_reason: 'badge_removed',
      role: 'owner',
      user_id: owner,
      verified_at: seedTime(15),
      verified_via: 'badge_claim'
    }),
    insert('listing_claim_holds', {
      created_at: seedTime(4),
      listing_id: seedListingId(seedListings.held.slug),
      reason: 'admin',
      source: SEED_ID
    })
  ]
}

interface RevisionDefinition {
  author: string
  days: number
  event: string
  fields: Record<string, SeedValue>
  id: string
  listing: string
  status: string
}

function revisionStatements(): SeedStatement[] {
  const reviewer = seedUsers.admin.email
  const revisions: RevisionDefinition[] = [
    {
      ...seedRevisions.pending_review,
      author: seedUsers.submitter.id,
      days: 1,
      event: 'created',
      fields: {},
      status: 'pending_review'
    },
    {
      ...seedRevisions.changes_requested,
      author: seedUsers.owner.id,
      days: 2,
      event: 'changes_requested',
      fields: {
        reviewed_at: seedTime(2),
        reviewed_by: reviewer,
        reviewer_note: 'Keep the description to one sentence.'
      },
      status: 'changes_requested'
    },
    {
      ...seedRevisions.approved,
      author: seedUsers.owner.id,
      days: 12,
      event: 'approved',
      fields: { reviewed_at: seedTime(12), reviewed_by: reviewer },
      status: 'approved'
    },
    {
      ...seedRevisions.rejected,
      author: seedUsers.owner.id,
      days: 11,
      event: 'rejected',
      fields: {
        rejection_reason: 'The new description is not about the product.',
        reviewed_at: seedTime(11),
        reviewed_by: reviewer
      },
      status: 'rejected'
    },
    {
      ...seedRevisions.withdrawn,
      author: seedUsers.owner.id,
      days: 10,
      event: 'withdrawn',
      fields: {},
      status: 'withdrawn'
    }
  ]
  const listings = new Map(fixtureSeedListings().map(listing => [listing.slug, listing]))
  return revisions.flatMap(revision => {
    const listing = listings.get(revision.listing)
    if (!listing) throw new Error(`Revision ${revision.id} names an unknown listing.`)
    const open = revision.status === 'pending_review' || revision.status === 'changes_requested'
    return [
      insert('listing_revisions', {
        author_user_id: revision.author,
        // An open revision is based on the listing as it stands, so approving it applies.
        base_checksum: open ? listingChecksum(listing.slug) : `fixture-${listing.slug}-v0`,
        category_slug: listing.category,
        content: `${listing.content} Edited by its owner.`,
        created_at: seedTime(revision.days + 1),
        description: `${listing.description.replace(/\.$/u, '')}, as its owner describes it.`,
        id: revision.id,
        listing_id: seedListingId(listing.slug),
        logo_url: logoSource(listing.slug),
        name: listing.name,
        status: revision.status,
        updated_at: seedTime(revision.days),
        ...revision.fields
      }),
      insert('listing_revision_events', {
        actor:
          revision.event === 'created' || revision.event === 'withdrawn'
            ? revision.author
            : reviewer,
        created_at: seedTime(revision.days),
        event_type: revision.event,
        revision_id: revision.id
      })
    ]
  })
}

function badgeProgramStatements(): SeedStatement[] {
  const check = (slug: string, days: number, kind: string, reason: string | null) =>
    insert('badge_checks', {
      checked_at: seedTime(days),
      conclusive: 1,
      kind,
      listing_id: seedListingId(slug),
      outcome: reason ? 'fail' : 'pass',
      reason
    })
  return [
    // Passing: the submitted listing's weekly check.
    check(seedListings.submitted.slug, 3, 'weekly', null),
    // Warning: a weekly miss, not yet rechecked.
    check(seedListings.owned.slug, 1, 'weekly', 'badge_missing'),
    // Confirmed misses: one unlisted (free submission), one owner removed (badge claim).
    check(seedListings.unlisted.slug, 10, 'weekly', 'badge_missing'),
    check(seedListings.unlisted.slug, 9, 'confirmation', 'badge_missing'),
    check(seedListings.ownerRemoved.slug, 10, 'weekly', 'badge_missing'),
    check(seedListings.ownerRemoved.slug, 9, 'confirmation', 'badge_missing'),
    insert('listing_events', {
      actor: BADGE_PROGRAM_ACTOR,
      created_at: seedTime(9),
      detail: JSON.stringify({ note: null, reason: 'badge_missing' }),
      event_type: 'unpublished',
      listing_id: seedListingId(seedListings.unlisted.slug)
    }),
    insert('listing_events', {
      actor: BADGE_PROGRAM_ACTOR,
      created_at: seedTime(9),
      detail: JSON.stringify({ reason: 'badge_removed', userId: seedUsers.owner.id }),
      event_type: 'owner_revoked',
      listing_id: seedListingId(seedListings.ownerRemoved.slug)
    })
  ]
}

const writer = (number: number) => `fixture-writer-${String(number).padStart(2, '0')}`

/**
 * Each tag's listings (`seedTags`), as `[slug, sort_order]`: `sort_order` 0 is the listing's most
 * central tag.
 */
const TAG_MEMBERS: Record<keyof typeof seedTags, ReadonlyArray<readonly [string, number]>> = {
  noteTaking: [
    [seedListings.submitted.slug, 0],
    ...Array.from({ length: 11 }, (_, index) => [writer(index + 1), 0] as const)
  ],
  documentEditors: [
    [seedListings.paid.slug, 0],
    [seedListings.submitted.slug, 1],
    [writer(12), 0],
    [seedListings.unlisted.slug, 0]
  ],
  whiteboards: [
    [seedListings.claimable.slug, 0],
    [seedListings.noLogo.slug, 0]
  ],
  mockups: [
    [seedListings.detail.slug, 0],
    [seedListings.claimable.slug, 1]
  ],
  apis: [
    [seedListings.held.slug, 0],
    [seedListings.owned.slug, 0],
    [seedListings.ownerRemoved.slug, 0]
  ],
  empty: [],
  retired: [
    [writer(1), 1],
    [writer(2), 1]
  ]
}

/** "note taking app" → "Best Note Taking Apps". */
function bestTitle(keyword: string): string {
  return `Best ${keyword.replace(/\b[a-z]/gu, letter => letter.toUpperCase())}s`
}

/**
 * The taxonomy (#341): tags on the seed's categories with their memberships (one tag retired once
 * its listings were tagged, as retiring leaves memberships), best pages with pins and an
 * exclusion, and redirects of old taxonomy URLs to each kind of target.
 */
function taxonomyStatements(): SeedStatement[] {
  const tags = Object.entries(seedTags) as Array<
    [keyof typeof seedTags, (typeof seedTags)[keyof typeof seedTags]]
  >
  const statements: SeedStatement[] = tags.map(([, tag], index) => ({
    sql: `INSERT INTO tags (id,slug,name,description,category_id,sort_order,is_active,created_at,
        updated_at) SELECT ?,?,?,?,id,?,1,?,? FROM categories WHERE slug=?`,
    params: [
      index + 1,
      tag.slug,
      tag.name,
      `${tag.name} in the local fixture seed.`,
      index,
      seedTime(30),
      seedTime(30),
      tag.category.slug
    ]
  }))
  for (const [key, tag] of tags) {
    for (const [slug, sortOrder] of TAG_MEMBERS[key]) {
      statements.push({
        sql: 'INSERT INTO listing_tags (listing_id,tag_id,sort_order) SELECT ?,id,? FROM tags WHERE slug=?',
        params: [seedListingId(slug), sortOrder, tag.slug]
      })
    }
  }
  statements.push({
    sql: 'UPDATE tags SET is_active=0,updated_at=? WHERE slug=?',
    params: [seedTime(10), seedTags.retired.slug]
  })
  for (const [index, page] of Object.values(seedBestPages).entries()) {
    const title = bestTitle(page.keyword)
    statements.push({
      sql: `INSERT INTO best_pages (id,slug,keyword,title,heading,intro,tag_id,category_id,list_size,
          keyword_volume,keyword_checked_at,sort_order,is_active,created_at,updated_at)
        VALUES (?,?,?,?,?,?,(SELECT id FROM tags WHERE slug=?),
          (SELECT id FROM categories WHERE slug=?),?,?,?,?,1,?,?)`,
      params: [
        index + 1,
        page.slug,
        page.keyword,
        title,
        title,
        `The local fixture seed's best page for "${page.keyword}". Every listing on it is made up.`,
        page.tag?.slug ?? null,
        page.category?.slug ?? null,
        page.tag && !page.category ? 10 : 5,
        index === 0 ? 1900 : null,
        index === 0 ? seedTime(6) : null,
        index,
        seedTime(5),
        seedTime(5)
      ]
    })
    for (const [position, pin] of page.pins.entries()) {
      statements.push(
        insert('best_page_listings', {
          best_page_id: index + 1,
          blurb: position === 0 ? `${pin.name} is the fixture pick for "${page.keyword}".` : null,
          excluded: 0,
          listing_id: seedListingId(pin.slug),
          position: position + 1
        })
      )
    }
    for (const excluded of page.excluded) {
      statements.push(
        insert('best_page_listings', {
          best_page_id: index + 1,
          blurb: null,
          excluded: 1,
          listing_id: seedListingId(excluded.slug),
          position: null
        })
      )
    }
  }
  for (const redirect of seedTaxonomyRedirects) {
    const target = (kind: string) => (redirect.to.kind === kind ? redirect.to.slug : null)
    statements.push({
      sql: `INSERT INTO taxonomy_redirects (source_kind,source_slug,target_kind,target_category_id,
          target_tag_id,target_best_page_id,manifest_id,created_at)
        VALUES (?,?,?,(SELECT id FROM categories WHERE slug=?),(SELECT id FROM tags WHERE slug=?),
          (SELECT id FROM best_pages WHERE slug=?),?,?)`,
      params: [
        redirect.from.kind,
        redirect.from.slug,
        redirect.to.kind,
        target('category'),
        target('tag'),
        target('best'),
        SEED_ID,
        seedTime(5)
      ]
    })
  }
  return statements
}

/** Every row of the seed but its hosted media, in foreign-key order. */
export function fixtureSeedStatements(): SeedStatement[] {
  return [
    ...catalogStatements(),
    ...taxonomyStatements(),
    ...userStatements(),
    ...submissionStatements(),
    ...ownershipStatements(),
    ...revisionStatements(),
    ...badgeProgramStatements()
  ]
}

import { type APIRequestContext, expect } from '@playwright/test'
import { q, unique } from './admin-fixture'
import {
  badgeCategory,
  badgeD1,
  badgeOrigin,
  badgeSuiteEnabled,
  seedBadgeCatalog,
  seedBadgeListing
} from './badge-program-fixture'
import { type FixtureProduct, type FixtureSite, startFixtureSite } from './submit-fixture'
import { test } from './test'

/**
 * The weekly badge program (serpcompany/best.serp.co#66) end to end: a local Worker runs
 * `scheduled()` through `/__scheduled` (as `wrangler dev --test-scheduled` does) against
 * fixture websites on `*.localtest.me`, with its D1 and email outbox checked after each run.
 *
 * - The weekly trigger checks only free submitted listings and badge-claimed listings: never a
 *   curated (admin) listing or a paid one. A conclusive miss sends "badge missing"; an
 *   unreachable site is inconclusive and sends nothing.
 * - The daily trigger rechecks each warning: a fixed badge keeps the listing; a confirmed miss
 *   unpublishes a free listing (410, "unlisted") or removes a badge claimer's ownership while
 *   the listing stays up ("ownership removed").
 * - Every trigger replayed, and the hourly continuation, change nothing and send nothing twice.
 */

test.skip(!badgeSuiteEnabled, 'needs the local badge program Worker from playwright.config.ts')
test.describe.configure({ mode: 'serial' })
test.use({ baseURL: badgeOrigin() })

const WEEKLY = '15 3 * * 1'
const DAILY = '45 3 * * *'
const HOURLY = '0 * * * *'

interface OutboxMessage {
  subject: string
  text: string
}

async function trigger(request: APIRequestContext, cron: string): Promise<void> {
  const response = await request.get(`/__scheduled?cron=${encodeURIComponent(cron)}`)
  expect(response.status(), await response.text()).toBe(200)
}

async function emailsTo(request: APIRequestContext, to: string): Promise<string[]> {
  const response = await request.get(`/api/dev/email-outbox?to=${encodeURIComponent(to)}`)
  expect(response.status()).toBe(200)
  return ((await response.json()) as { messages: OutboxMessage[] }).messages
    .map(message => message.subject)
    .sort()
}

type Kind = 'claim' | 'curated' | 'down' | 'fixed' | 'free' | 'gone' | 'paid'

interface Seeded {
  email: string
  id: string
  label: string
  slug: string
}

let fixture: FixtureSite
const seeded = new Map<Kind, Seeded>()

function seed(kind: Kind, product: FixtureProduct): Seeded {
  const key = `${kind}-${unique()}`
  const label = `badge-${key}`
  fixture.set(label, product)
  const slug = fixture.slug(label)
  const listing = {
    email: `${kind}-${key}@example.com`,
    id: `e2e-badge-${key}`,
    label,
    slug
  }
  const userId = `e2e-badge-user-${key}`
  const source = kind === 'claim' || kind === 'curated' ? 'admin' : 'submission'
  badgeD1(`
    INSERT INTO users (id, name, email, email_verified)
      VALUES (${q(userId)}, 'E2E owner', ${q(listing.email)}, 1);
  `)
  seedBadgeListing({
    checksum: `e2e-${key}`,
    content: 'A listing for the badge program suite.',
    description: product.description,
    id: listing.id,
    name: product.name,
    published_at: '2026-05-16',
    slug,
    source,
    source_identity: listing.id,
    source_kind: 'e2e',
    website: fixture.website(label)
  })
  if (source === 'submission') {
    const paid = kind === 'paid'
    badgeD1(`
      INSERT INTO listing_submissions (id, slug, name, description, website, content,
        category_slug, logo_url, status, plan, paid_at, listing_id, owner_user_id)
      VALUES (${q(`sub-${key}`)}, ${q(slug)}, ${q(product.name)}, ${q(product.description)},
        ${q(fixture.website(label))}, 'c', ${q(badgeCategory.slug)}, ${q(`${fixture.website(label)}icon.png`)},
        'approved', ${paid ? "'paid'" : "'free'"}, ${paid ? q(new Date().toISOString()) : 'NULL'},
        ${q(listing.id)}, ${q(userId)});
      INSERT INTO listing_owners (listing_id, user_id, verified_via, verified_at)
        VALUES (${q(listing.id)}, ${q(userId)}, 'submission', ${q(new Date().toISOString())});
    `)
  } else if (kind === 'claim') {
    badgeD1(`
      INSERT INTO listing_owners (listing_id, user_id, verified_via, verified_at)
        VALUES (${q(listing.id)}, ${q(userId)}, 'badge_claim', ${q(new Date().toISOString())});
    `)
  }
  seeded.set(kind, listing)
  return listing
}

function get(kind: Kind): Seeded {
  const listing = seeded.get(kind)
  if (!listing) throw new Error(`${kind} was not seeded`)
  return listing
}

function checks(kind: Kind) {
  return badgeD1<{ conclusive: number; kind: string; outcome: string; reason: string | null }>(
    `SELECT kind, outcome, reason, conclusive FROM badge_checks
      WHERE listing_id = ${q(get(kind).id)} ORDER BY id`
  )
}

/** The fixture site's host, with its port, as the emails name it. */
function host(kind: Kind): string {
  return new URL(fixture.website(get(kind).label)).host
}

function version(): number {
  return Number(
    badgeD1<{ version: number }>('SELECT version FROM publication_state WHERE id = 1')[0]?.version
  )
}

test.beforeAll(async () => {
  fixture = await startFixtureSite()
  seedBadgeCatalog()
  const product = (name: string, badge: FixtureProduct['badge']): FixtureProduct => ({
    badge,
    description: `${name}, a fixture product.`,
    name
  })
  seed('free', product('Free product', 'missing'))
  seed('fixed', product('Fixed product', 'missing'))
  seed('claim', product('Claimed product', 'nofollow'))
  seed('down', { ...product('Down product', 'missing'), status: 503 })
  seed('gone', { ...product('Gone product', 'valid'), status: 404 })
  seed('curated', product('Curated product', 'missing'))
  seed('paid', product('Paid product', 'missing'))
})

test.afterAll(async () => {
  await fixture?.close()
})

test('the weekly pass warns on conclusive misses only, and checks no curated or paid listing', async ({
  request
}) => {
  await trigger(request, WEEKLY)

  expect(checks('free')).toEqual([
    { conclusive: 1, kind: 'weekly', outcome: 'fail', reason: 'badge_missing' }
  ])
  expect(checks('claim')).toEqual([
    { conclusive: 1, kind: 'weekly', outcome: 'fail', reason: 'link_not_followed' }
  ])
  // A 5xx can't tell; a 4xx is a miss right away (owner decision on #106).
  expect(checks('down')).toEqual([
    { conclusive: 0, kind: 'weekly', outcome: 'fail', reason: 'http_503' }
  ])
  expect(checks('gone')).toEqual([
    { conclusive: 1, kind: 'weekly', outcome: 'fail', reason: 'http_404' }
  ])
  for (const kind of ['curated', 'paid'] as const) {
    expect(checks(kind), kind).toEqual([])
    expect(fixture.requests(get(kind).label), kind).toBe(0)
  }

  expect(await emailsTo(request, get('free').email)).toEqual([
    `Action needed: the SERP badge is missing on ${host('free')}`
  ])
  expect(await emailsTo(request, get('claim').email)).toEqual([
    `Action needed: the SERP badge is missing on ${host('claim')}`
  ])
  expect(await emailsTo(request, get('down').email)).toEqual([])
  expect(await emailsTo(request, get('gone').email)).toEqual([
    `Action needed: the SERP badge is missing on ${host('gone')}`
  ])

  // Replayed, and continued by the hourly trigger: nothing is checked or sent again.
  const fetched = fixture.requests(get('free').label)
  await trigger(request, WEEKLY)
  await trigger(request, HOURLY)
  expect(fixture.requests(get('free').label)).toBe(fetched)
  expect(checks('free')).toHaveLength(1)
  expect(await emailsTo(request, get('free').email)).toHaveLength(1)
  // Writing checks never moves the catalog.
  expect(version()).toBe(0)
})

test('the daily pass rechecks each warning and unpublishes or revokes on a confirmed miss', async ({
  request
}) => {
  // The warnings were sent two days ago, so today's window rechecks them.
  badgeD1(`
    UPDATE badge_checks SET checked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 days')
      WHERE kind = 'weekly'
  `)
  fixture.update(get('fixed').label, { badge: 'valid' })
  const page = await request.get(`/products/${get('free').slug}/`)
  expect(page.status()).toBe(200)

  await trigger(request, DAILY)

  expect(checks('free').at(-1)).toEqual({
    conclusive: 1,
    kind: 'confirmation',
    outcome: 'fail',
    reason: 'badge_missing'
  })
  expect(checks('fixed').at(-1)).toEqual({
    conclusive: 1,
    kind: 'confirmation',
    outcome: 'pass',
    reason: null
  })
  // The free listing is unpublished through the reviewed path: 410, logged, version bumped.
  // Pages turn over with the catalog epoch, which the Worker re-reads within seconds.
  await expect(async () => {
    const gone = await request.get(`/products/${get('free').slug}/`)
    expect(gone.status()).toBe(410)
    expect(await gone.text()).toContain('Free product is no longer listed')
  }).toPass({ intervals: [1_000, 2_000, 5_000], timeout: 90_000 })
  expect(
    badgeD1(`SELECT event_type, actor FROM listing_events WHERE listing_id = ${q(get('free').id)}`)
  ).toEqual([{ actor: 'badge-program', event_type: 'unpublished' }])
  // The claimed listing stays up, without its owner.
  expect((await request.get(`/products/${get('claim').slug}/`)).status()).toBe(200)
  expect(
    badgeD1(`SELECT revoked_reason FROM listing_owners WHERE listing_id = ${q(get('claim').id)}`)
  ).toEqual([{ revoked_reason: 'badge_removed' }])
  // The 404 site, still 404 on the recheck, is unpublished too.
  expect(checks('gone').at(-1)).toEqual({
    conclusive: 1,
    kind: 'confirmation',
    outcome: 'fail',
    reason: 'http_404'
  })
  expect(badgeD1(`SELECT is_active FROM listings WHERE id = ${q(get('gone').id)}`)).toEqual([
    { is_active: 0 }
  ])
  expect(version()).toBe(3)
  // The fixed listing and the unreachable one stay as they were.
  expect(
    badgeD1(
      `SELECT is_active FROM listings WHERE id IN (${q(get('fixed').id)}, ${q(get('down').id)})`
    )
  ).toEqual([{ is_active: 1 }, { is_active: 1 }])

  expect(await emailsTo(request, get('free').email)).toEqual([
    `Action needed: the SERP badge is missing on ${host('free')}`,
    'Free product has been removed from SERP'
  ])
  expect(await emailsTo(request, get('claim').email)).toEqual([
    `Action needed: the SERP badge is missing on ${host('claim')}`,
    'You no longer manage Claimed product on SERP'
  ])
  expect(await emailsTo(request, get('fixed').email)).toHaveLength(1)

  // Replayed: no second unpublish, revocation, or email.
  await trigger(request, DAILY)
  await trigger(request, HOURLY)
  expect(version()).toBe(3)
  expect(await emailsTo(request, get('free').email)).toHaveLength(2)
  expect(await emailsTo(request, get('claim').email)).toHaveLength(2)
  for (const kind of ['curated', 'paid'] as const) {
    expect(fixture.requests(get(kind).label), kind).toBe(0)
  }
})

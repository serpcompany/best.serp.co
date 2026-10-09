import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import {
  fixtureSeedImages,
  fixtureSeedListings,
  fixtureSeedStatements,
  type SeedStatement,
  type SeedValue,
  seedListingId
} from '../apps/web/e2e/fixture-seed'
import {
  SEED_ID,
  SEED_NOW,
  seedCategories,
  seedFacts,
  seedListings,
  seedRevisions,
  seedSubmissions,
  seedUsers
} from '../apps/web/e2e/seed-facts'
import { validateCanonicalLocalConfig } from './d1-local-config'
import { localD1StateDirectoryName, resolveFreshD1StateRoot } from './d1-local-state'
import { solidPng } from './fixtures/solid-png'
import { project } from './project'

/**
 * `pnpm db:seed:local` (serpcompany/best.serp.co#312): local D1 from fixtures, not the real
 * catalog. `d1-local-guard.ts seed` resets the canonical local state (after the local config
 * check), applies the migrations, and calls `seedLocalFixtures()`, which writes the seed's rows in
 * one D1 batch and hosts its logos through the real ingestion path into local R2. Every value is
 * bound, every time is fixed, so a re-run writes the same rows. `pnpm db:verify:local` checks a
 * seeded D1 against the seed's facts (`seedFactViolations`).
 */

/** The `migration_runs` row that marks a local D1 as seeded (the import writes its own). */
export const SEED_RUN_ID = `migration-${SEED_ID}`
const SEED_WORKFLOW = 'local/db-seed-local'

/**
 * The seed writes only local state: the Worker config must be the dedicated local one (local D1
 * identity, local media bucket, `D1_RUNTIME_ENV=local`), no binding may be `remote`, which
 * would send the platform proxy's writes to a Cloudflare resource, and no `CLOUDFLARE_ENV` may
 * name a Wrangler environment (#313).
 */
export function assertLocalSeedTarget(
  configPath: string = project.wranglerConfigPath,
  environment: Readonly<Record<string, string | undefined>> = process.env
): void {
  if (environment.CLOUDFLARE_ENV) {
    throw new Error(
      `Refusing to seed with CLOUDFLARE_ENV=${environment.CLOUDFLARE_ENV}: the seed writes only local state. Unset it.`
    )
  }
  validateCanonicalLocalConfig(configPath)
  const config = JSON.parse(readFileSync(resolve(configPath), 'utf8')) as Record<string, unknown>
  const remote = Object.values(config)
    .filter(Array.isArray)
    .flat()
    .filter(
      (binding): binding is { binding?: string; remote: unknown } =>
        typeof binding === 'object' && binding !== null && 'remote' in binding
    )
    .filter(binding => binding.remote !== false)
    .map(binding => binding.binding ?? 'unnamed')
  if (remote.length > 0) {
    throw new Error(
      `Refusing to seed through a remote binding: ${remote.join(', ')}. The seed writes only local state.`
    )
  }
}

function isInside(path: string, base: string): boolean {
  const offset = relative(base, path)
  return offset !== '' && !offset.startsWith('..') && !isAbsolute(offset)
}

/** The path with its longest existing prefix resolved through symlinks. */
function physicalPath(path: string): string {
  let existing = path
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing)
  return join(realpathSync(existing), relative(existing, path))
}

export interface ResettableBases {
  /** The user's home directory, which the temp directory must not hold (default `homedir()`). */
  homeDirectory?: string
  /** This checkout: `.wrangler/drizzle-state/` and a worktree's `.runtime/` live inside it. */
  repositoryRoot: string
  /** Throwaway state (`mktemp -d`, the tests' `mkdtemp`) lives inside it. */
  temporaryRoot: string
}

/**
 * The temp directory counts only while it holds neither this checkout nor the home directory:
 * it follows `$TMPDIR`, and `TMPDIR=/` must not make `$HOME/x/drizzle/best-serp-co` resettable
 * (#316 review, #313).
 */
function temporaryBase(bases: ResettableBases): string[] {
  const temporary = resolve(bases.temporaryRoot)
  const holds = (path: string) => {
    const target = resolve(path)
    return (
      target === temporary ||
      isInside(target, temporary) ||
      physicalPath(target) === physicalPath(temporary) ||
      isInside(physicalPath(target), physicalPath(temporary))
    )
  }
  return [bases.repositoryRoot, bases.homeDirectory ?? homedir()].some(holds) ? [] : [temporary]
}

/**
 * The canonical local state root, refusing any other path: the seed deletes it, so it must be
 * `<state>/drizzle/best-serp-co` or the checkout's `.wrangler/drizzle-state/best-serp-co`, as
 * `resolveFreshD1StateRoot` builds them, inside this checkout or the system temp directory (unless
 * that holds the checkout or the home directory), also once symlinks are resolved. A stale
 * `HARNESS_D1_STATE_DIRECTORY` or runtime manifest pointing anywhere else is refused (#316 review).
 */
export function assertResettableStateRoot(
  stateRoot: string,
  bases: ResettableBases = { repositoryRoot: resolve('.'), temporaryRoot: tmpdir() }
): string {
  const absolute = resolve(stateRoot)
  const allowed = [resolve(bases.repositoryRoot), ...temporaryBase(bases)]
  // The checkout's own state when no runtime or harness directory is set.
  const checkoutDefault = resolveFreshD1StateRoot({ repositoryRoot: bases.repositoryRoot })
  if (
    basename(absolute) !== localD1StateDirectoryName ||
    (basename(dirname(absolute)) !== 'drizzle' && absolute !== checkoutDefault) ||
    !allowed.some(base => isInside(absolute, base)) ||
    !allowed.some(base => isInside(physicalPath(absolute), physicalPath(base)))
  ) {
    throw new Error(
      `Refusing to reset ${absolute}: only a local D1 state root (<state>/drizzle/${localD1StateDirectoryName}, or ${checkoutDefault}) inside this checkout or the system temp directory is reset.`
    )
  }
  return absolute
}

/** Deletes the local D1, R2, and cache state below the canonical root. */
export function resetLocalState(stateRoot: string, bases?: ResettableBases): void {
  rmSync(assertResettableStateRoot(stateRoot, bases), { force: true, recursive: true })
}

/** The seed's identity: a digest of its statements and images, recorded on its run. */
export function seedChecksum(): string {
  return createHash('sha256')
    .update(JSON.stringify({ images: fixtureSeedImages(), statements: fixtureSeedStatements() }))
    .digest('hex')
}

/** The run marker, then every row: one batch. */
export function seedStartStatements(): SeedStatement[] {
  const checksum = seedChecksum()
  return [
    {
      sql: `INSERT INTO migration_runs (id,schema_version,manifest_identity,input_checksum,
        target_checksum,affected_records,outcome,started_at,completed_at)
        VALUES (?,1,?,?,?,?,'started',?,NULL)`,
      params: [SEED_RUN_ID, SEED_ID, checksum, checksum, fixtureSeedListings().length, SEED_NOW]
    },
    ...fixtureSeedStatements()
  ]
}

/** Completes the run once the media is hosted, recording the catalog checksum it reached. */
export function seedFinishStatement(): SeedStatement {
  return {
    sql: `UPDATE migration_runs SET outcome='succeeded',completed_at=?,
      target_checksum=(SELECT checksum FROM publication_state WHERE id=1)
      WHERE id=? AND outcome='started'`,
    params: [SEED_NOW, SEED_RUN_ID]
  }
}

/** Writes the seed into the canonical local state, which must hold only the migrations. */
export async function seedLocalFixtures(): Promise<void> {
  const { hostListingImages, withLocalPlatform } = await import('./seed-local-media')
  const images = fixtureSeedImages()
  await withLocalPlatform(async env => {
    const batch = async (statements: SeedStatement[]) => {
      const results = await env.DB.batch(
        statements.map(statement => env.DB.prepare(statement.sql).bind(...statement.params))
      )
      if (results.some(result => !result.success)) throw new Error('The seed batch failed.')
    }
    await batch(seedStartStatements())
    await hostListingImages(
      env,
      images.map(image => ({
        bytes: solidPng(image.width, image.height, image.rgb),
        kind: image.kind,
        listingId: image.listingId,
        sourceUrl: image.sourceUrl
      })),
      { actor: SEED_ID, clock: () => new Date(SEED_NOW), workflow: SEED_WORKFLOW }
    )
    await batch([seedFinishStatement()])
  })
  console.log(
    `Seeded local D1 with fixtures: ${seedFacts.listingCount} published listings, ${images.length} hosted images.`
  )
}

export type SeedQuery = (sql: string, params?: SeedValue[]) => Array<Record<string, unknown>>

const PUBLISHED = `l.status='approved' AND l.is_active=1 AND l.published_at IS NOT NULL`

/** The first column of the first row. */
function firstValue(query: SeedQuery, sql: string, params: SeedValue[] = []): unknown {
  return Object.values(query(sql, params)[0] ?? {})[0]
}

/**
 * Where a seeded D1 departs from the seed's facts (`seed-facts.ts`); empty when it matches.
 * `media` checks the hosted logos and images too (absent when only the statements ran), and
 * `marker` the completed seed run.
 */
export function seedFactViolations(
  query: SeedQuery,
  options: { marker: boolean; media: boolean }
): string[] {
  const violations: string[] = []
  const expect = (label: string, actual: unknown, expected: unknown) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      violations.push(
        `${label}: expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`
      )
    }
  }
  const value = (sql: string, params: SeedValue[] = []) => firstValue(query, sql, params)
  const list = (sql: string, params: SeedValue[] = []) =>
    query(sql, params).map(row => Object.values(row)[0])

  expect(
    'published listings',
    value(`SELECT COUNT(*) FROM listings l WHERE ${PUBLISHED}`),
    seedFacts.listingCount
  )
  expect(
    'categories with a published listing',
    value(`SELECT COUNT(DISTINCT lc.category_id) FROM listing_categories lc
      JOIN listings l ON l.id=lc.listing_id WHERE ${PUBLISHED}`),
    seedFacts.categoryCount
  )
  const inCategory = (slug: string) =>
    value(
      `SELECT COUNT(*) FROM listing_categories lc JOIN listings l ON l.id=lc.listing_id
        JOIN categories c ON c.id=lc.category_id WHERE c.slug=? AND c.is_active=1 AND ${PUBLISHED}`,
      [slug]
    )
  expect(
    'paginated category listings',
    inCategory(seedFacts.paginatedCategory.slug),
    seedFacts.paginatedCategory.listingCount
  )
  expect('empty category listings', inCategory(seedFacts.emptyCategory.slug), 0)
  expect(
    'categories',
    list('SELECT slug FROM categories WHERE is_active=1 ORDER BY slug'),
    Object.values(seedCategories)
      .map(category => category.slug)
      .sort()
  )
  expect(
    'featured listings',
    value(`SELECT COUNT(*) FROM listings l WHERE l.is_featured=1 AND ${PUBLISHED}`),
    seedFacts.featuredCount
  )

  const state = (slug: string) =>
    value(
      `SELECT CASE WHEN ${PUBLISHED} THEN 'published'
        WHEN l.status='approved' AND l.published_at IS NOT NULL THEN 'unpublished'
        ELSE l.status END FROM listings l WHERE l.slug=?`,
      [slug]
    ) ?? 'missing'
  const unpublished: string[] = [seedListings.unlisted.slug]
  const drafts: string[] = [seedListings.draft.slug]
  for (const listing of Object.values(seedListings)) {
    const expected = unpublished.includes(listing.slug)
      ? 'unpublished'
      : drafts.includes(listing.slug)
        ? 'draft'
        : 'published'
    expect(`${listing.slug} state`, state(listing.slug), expected)
    expect(
      `${listing.slug} name`,
      value('SELECT name FROM listings WHERE slug=?', [listing.slug]),
      listing.name
    )
  }
  expect(
    'detail listing primary category',
    value(
      `SELECT c.slug FROM listing_categories lc JOIN categories c ON c.id=lc.category_id
        JOIN listings l ON l.id=lc.listing_id WHERE l.slug=? AND lc.is_primary=1`,
      [seedListings.detail.slug]
    ),
    seedListings.detail.category.slug
  )

  const term = seedFacts.search.query.toLowerCase()
  expect(
    `listings matching "${term}"`,
    list(
      `SELECT l.slug FROM listings l WHERE ${PUBLISHED} AND (instr(lower(l.name),?)>0
        OR instr(lower(l.description),?)>0 OR instr(lower(l.slug),?)>0) ORDER BY l.slug`,
      [term, term, term]
    ),
    seedFacts.search.listings.map(listing => listing.slug).sort()
  )

  expect(
    'users',
    list('SELECT email FROM users ORDER BY email'),
    Object.values(seedUsers)
      .map(user => user.email)
      .sort()
  )
  expect(
    'fixture admin allowlisted',
    value('SELECT COUNT(*) FROM admin_allowlist WHERE email=?', [seedUsers.admin.email]),
    1
  )
  expect(
    'submission statuses',
    list('SELECT DISTINCT status FROM listing_submissions ORDER BY status'),
    Object.keys(seedSubmissions).sort()
  )
  for (const [status, submission] of Object.entries(seedSubmissions)) {
    expect(
      `submission ${submission.id}`,
      value('SELECT status FROM listing_submissions WHERE id=? AND owner_user_id=?', [
        submission.id,
        seedUsers.submitter.id
      ]),
      status
    )
  }
  expect(
    'revision statuses',
    list('SELECT DISTINCT status FROM listing_revisions ORDER BY status'),
    Object.keys(seedRevisions).sort()
  )
  const currentOwner = (slug: string) =>
    value(
      `SELECT u.email FROM listing_owners o JOIN users u ON u.id=o.user_id
        WHERE o.listing_id=? AND o.revoked_at IS NULL`,
      [seedListingId(slug)]
    ) ?? null
  expect('owned listing owner', currentOwner(seedListings.owned.slug), seedUsers.owner.email)
  expect(
    'submitted listing owner',
    currentOwner(seedListings.submitted.slug),
    seedUsers.submitter.email
  )
  expect('claimable listing owner', currentOwner(seedListings.claimable.slug), null)
  expect('owner-removed listing owner', currentOwner(seedListings.ownerRemoved.slug), null)
  expect(
    'held listing',
    value('SELECT COUNT(*) FROM listing_claim_holds WHERE listing_id=? AND cleared_at IS NULL', [
      seedListingId(seedListings.held.slug)
    ]),
    1
  )

  if (options.media) {
    const hosted = (kind: string) =>
      value(
        `SELECT COUNT(DISTINCT m.listing_id) FROM listing_media m JOIN listings l
          ON l.id=m.listing_id WHERE m.kind=? AND m.media_key IS NOT NULL AND ${PUBLISHED}`,
        [kind]
      )
    expect('listings with a hosted logo', hosted('logo'), seedFacts.hostedLogoCount)
    expect('listings with a hosted image', hosted('image'), seedFacts.hostedImageCount)
    expect(
      'logo-less listing media',
      value('SELECT COUNT(*) FROM listing_media WHERE listing_id=?', [
        seedListingId(seedListings.noLogo.slug)
      ]),
      0
    )
  }
  if (options.marker) {
    expect(
      'seed run',
      value('SELECT outcome FROM migration_runs WHERE id=?', [SEED_RUN_ID]),
      'succeeded'
    )
  }
  return violations
}

/** Whether a local D1 was seeded with fixtures (rather than imported). */
export function isSeeded(query: SeedQuery): boolean {
  const runs = firstValue(query, 'SELECT COUNT(*) FROM migration_runs WHERE id=?', [SEED_RUN_ID])
  return Number(runs) > 0
}

/**
 * Whether an existing local D1 still needs `pnpm db:seed:local` before `pnpm agent:dev` serves it
 * (#313): its migrations never finished (a table is missing), nothing was written to it, or a
 * seed run started and never succeeded. An imported or completely seeded D1 is served as is.
 */
export function seedIncomplete(query: SeedQuery): boolean {
  try {
    const run = firstValue(query, 'SELECT outcome FROM migration_runs WHERE id=?', [SEED_RUN_ID])
    if (run !== undefined) return run !== 'succeeded'
    return Number(firstValue(query, 'SELECT COUNT(*) FROM publication_state')) === 0
  } catch (error) {
    if (/no such table/u.test(error instanceof Error ? error.message : String(error))) return true
    throw error
  }
}

import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { type APIRequestContext, expect } from '@playwright/test'
import {
  insert,
  listingStatements,
  type SeedStatement,
  type SeedValue,
  suiteCatalogStatements
} from './fixture-seed'
import { BILLING_PREVIEW_VARS } from './orders-worker'
import { type SyncPoster, startSyncPoster } from './sync-post'

/**
 * The admin panel suite (serpcompany/best.serp.co#64) runs on its own local Worker with its own
 * D1, which `playwright.suites.config.ts` starts from the already-built Worker: the suite
 * publishes and unpublishes listings, which would change the seeded catalog the smoke suite
 * counts exactly. Helpers here run SQL on that D1, seed fixture submissions, and sign in a fresh
 * admin. Never used against a deployed Worker.
 */

const playwrightPort = Number(process.env.PLAYWRIGHT_PORT ?? 3100)

/** Only when Playwright starts its own servers (not against an external or deployed Worker). */
export const adminSuiteEnabled =
  process.env.PLAYWRIGHT_EXTERNAL_SERVER !== '1' &&
  !process.env.PLAYWRIGHT_BASE_URL &&
  !process.env.PLAYWRIGHT_WEB_SERVER_COMMAND

export interface SuiteServer {
  port: number
  stateDirectory: string
}

/** A local preview Worker the D1 helpers reach, by its port: a suite's, or the main preview. */
export type LocalWorker = Pick<SuiteServer, 'port'>

export const adminServer: SuiteServer = {
  port: playwrightPort + 3,
  stateDirectory: resolve(tmpdir(), `best-serp-co-e2e-admin-${playwrightPort + 3}`)
}

/**
 * The account dashboard suite's own Worker and D1 (#65), from the same build: it publishes
 * listings and adds admins too, and sharing the admin suite's D1 made the two suites race on
 * the allowlist, the publication version, and SQLite write locks (#102 review round 2).
 */
export const accountServer: SuiteServer = {
  // +4 is the media suite's (#96).
  port: playwrightPort + 5,
  stateDirectory: resolve(tmpdir(), `best-serp-co-e2e-account-${playwrightPort + 5}`)
}

/**
 * What a suite Worker's preview needs for `suiteD1`: Wrangler's Local Explorer API on (its
 * default today, set so a change of default can't switch it off), and no Wrangler metrics.
 */
export const LOCAL_EXPLORER_ENV = 'X_LOCAL_EXPLORER=true WRANGLER_SEND_METRICS=false'

export function adminOrigin(server: LocalWorker = adminServer): string {
  return `http://127.0.0.1:${server.port}`
}

/**
 * Serves the built Worker on a fresh, migrated D1 of its own (seeded by the suite). The admin
 * Worker also has billing configured with the mocked provider (orders and claims are on
 * everywhere, #130 and #133): the orders suite (`billing.spec.ts`, #68) shares it
 * (`orders-worker.ts`) rather than starting another preview Worker on the CI runner.
 */
export function adminServerCommand(server: SuiteServer = adminServer): string {
  const state = server.stateDirectory
  const vars = server === adminServer ? BILLING_PREVIEW_VARS : []
  const previewVars = vars.length > 0 ? `LOCAL_PREVIEW_VARS=${vars.join(',')} ` : ''
  return [
    'cd ../..',
    `rm -rf "${state}"`,
    `mkdir -p "${state}"`,
    `HARNESS_D1_STATE_DIRECTORY="${state}" pnpm db:migrate:local`,
    `HARNESS_D1_STATE_DIRECTORY="${state}" ${previewVars}${LOCAL_EXPLORER_ENV} PORT=${server.port} pnpm tsx scripts/d1-local-preview.ts`
  ].join(' && ')
}

/** The category the admin and account suites' submissions and listings use. */
const adminCategory = {
  description: 'Tools for the admin panel suite.',
  name: 'E2E Tools',
  slug: 'e2e-tools'
} as const

/** The publication state and one category the suite's submissions use. */
export function seedAdminCatalog(server: SuiteServer = adminServer): void {
  runStatements(suiteCatalogStatements({ category: adminCategory, checksum: 'e2e-admin' }), server)
}

/** Every local preview's D1 (`d1_databases` in `wrangler.jsonc`, `project.local.databaseId`). */
const LOCAL_D1_DATABASE_ID = 'local-only-do-not-deploy'

let poster: SyncPoster | undefined

/** POSTs JSON synchronously (`sync-post.ts`), as the helpers here are synchronous. */
function postSync(url: string, body: string): { status: number; text: string } {
  poster ??= startSyncPoster()
  return poster.post(url, body)
}

interface D1QueryAnswer {
  errors?: { message?: string }[]
  result?: { results?: { columns?: string[]; rows?: unknown[][] } }[] | null
  success?: boolean
}

/**
 * A seed statement with its values written in as SQL literals: the Local Explorer binds strings
 * only. It reads SQL as `fixture-seed.ts`'s builders write it, plain `?` placeholders and
 * single-quoted strings, and refuses anything it could misread (a comment, a quoted identifier,
 * a numbered or named parameter) rather than guess.
 */
function inlined(statement: SeedStatement): string {
  const refuse = (problem: string): never => {
    throw new Error(`Local D1 can't inline ${problem}: ${statement.sql}`)
  }
  const values = [...statement.params]
  let quoted = false
  let sql = ''
  for (let index = 0; index < statement.sql.length; index += 1) {
    const char = statement.sql[index] as string
    const next = statement.sql[index + 1] ?? ''
    if (char === "'") quoted = !quoted
    if (quoted || char === "'") {
      sql += char
      continue
    }
    if (char === '"' || char === '`' || char === '[') refuse('a quoted identifier')
    if ((char === '-' && next === '-') || (char === '/' && next === '*')) refuse('a comment')
    if ((char === '?' && /\d/u.test(next)) || (/[:@$]/u.test(char) && /\w/u.test(next))) {
      refuse('a numbered or named parameter')
    }
    if (char !== '?') {
      sql += char
      continue
    }
    if (values.length === 0) refuse('more placeholders than values')
    const value = values.shift() as SeedValue
    if (typeof value === 'number' && !Number.isFinite(value)) refuse(`the number ${value}`)
    sql += value === null ? 'NULL' : typeof value === 'number' ? String(value) : q(value)
  }
  if (quoted) refuse('an unterminated string')
  if (values.length > 0) refuse('more values than placeholders')
  return sql
}

/**
 * Runs SQL on a local Worker's D1 through the Worker's own D1 Durable Object, the one its
 * `DB` binding queries: Wrangler's Local Explorer API (`/cdn-cgi/local/explorer/api`), which
 * every local preview serves, so this process's queries queue behind the Worker's. Never the
 * SQLite file: workerd waits for no lock, so a Worker query that met a write from this process
 * failed at once with a 500 "internal error", which the admin pages showed as React #441 (#200,
 * #204). A string may hold several statements; an array runs as one batch, in one transaction.
 * Returns the last statement's rows. Synchronous, so `localD1` and `runStatements` stay so.
 */
function suiteD1<T>(server: LocalWorker, statements: string | readonly SeedStatement[]): T[] {
  const queries =
    typeof statements === 'string'
      ? [{ sql: statements.trim() }]
      : statements.map(statement => ({ sql: inlined(statement) }))
  const { status, text } = postSync(
    `${adminOrigin(server)}/cdn-cgi/local/explorer/api/d1/database/${LOCAL_D1_DATABASE_ID}/raw`,
    JSON.stringify(queries.length === 1 ? queries[0] : { batch: queries })
  )
  let answer: D1QueryAnswer | null = null
  try {
    answer = JSON.parse(text) as D1QueryAnswer
  } catch {
    // Reported below with the status.
  }
  if (status !== 200 || !answer?.success) {
    const reasons = answer?.errors?.map(error => error.message).join('; ') || text.slice(0, 200)
    const hint =
      status === 404
        ? " Is Wrangler's Local Explorer API on for this Worker (X_LOCAL_EXPLORER=true)?"
        : ''
    throw new Error(
      `Local D1 query through Wrangler's Local Explorer API on port ${server.port} failed (${status}): ${reasons}.${hint}`
    )
  }
  const { columns = [], rows = [] } = answer.result?.at(-1)?.results ?? {}
  return rows.map(row => Object.fromEntries(columns.map((column, i) => [column, row[i]])) as T)
}

/** `suiteD1` for specs that await it (the claims suites, #200). */
export async function workerD1<T = Record<string, unknown>>(
  server: LocalWorker,
  statements: string | readonly SeedStatement[]
): Promise<T[]> {
  return suiteD1<T>(server, statements)
}

/**
 * Runs SQL on a local Worker's D1 (the admin suite's by default), through `suiteD1`, and
 * returns the last statement's rows. Rows built from values go through `runStatements` instead.
 */
export function localD1<T = Record<string, unknown>>(
  sql: string,
  server: LocalWorker = adminServer
): T[] {
  return suiteD1<T>(server, sql)
}

/**
 * Runs bound statements (`fixture-seed.ts`'s builders) on a suite Worker's local D1, in one
 * transaction, through `suiteD1`.
 */
export function runStatements(
  statements: readonly SeedStatement[],
  server: LocalWorker = adminServer
): void {
  if (statements.length > 0) suiteD1(server, statements)
}

/** SQL string literal. */
export function q(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

export function unique(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
}

/** A documentation-range client IP per request context, for the local sign-in limits. */
export function uniqueIp(): string {
  const octet = () => Math.floor(Math.random() * 250) + 1
  return `198.19.${octet()}.${octet()}`
}

export interface FixtureSubmission {
  id: string
  name: string
  slug: string
}

/** A free submission with a verified badge, waiting in the review queue, and its submitter. */
export function seedVerifiedSubmission(label: string, category: string): FixtureSubmission {
  const key = `${label}-${unique()}`
  const submission = {
    id: `e2e-${key}`,
    name: `E2E ${label} ${key.slice(-5)}`,
    slug: `${key}.example`
  }
  const userId = `e2e-user-${key}`
  const now = new Date().toISOString()
  localD1(`
    INSERT INTO users (id, name, email, email_verified) VALUES (${q(userId)}, 'E2E submitter',
      ${q(`submitter-${key}@example.com`)}, 1);
    INSERT INTO listing_submissions (id, slug, name, description, website, content, category_slug,
      logo_url, status, plan, owner_user_id, badge_verified_at, verification_attempts, block_key,
      block_covers_subdomains, created_at, updated_at)
    VALUES (${q(submission.id)}, ${q(submission.slug)}, ${q(submission.name)},
      'A fixture submission for the admin panel suite.', ${q(`https://${submission.slug}/`)},
      'It helps the admin panel suite review submissions end to end.', ${q(category)},
      ${q(`https://${submission.slug}/logo.png`)}, 'verified', 'free', ${q(userId)}, ${q(now)}, 1,
      ${q(submission.slug)}, 1, CURRENT_TIMESTAMP, ${q(now)});
    INSERT INTO listing_submission_events (submission_id, event_type, actor)
      VALUES (${q(submission.id)}, 'badge_verified', 'e2e');
  `)
  return submission
}

/**
 * A live listing as the one-time import left it (`legacy-json-migration-v1`): no submission, and
 * either no logo (the fallback tile) or a site-relative one (`/listing-logos/…`).
 */
export function seedImportedListing(
  label: string,
  category: string,
  logoUrl: string | null
): FixtureSubmission {
  const key = `${label}-${unique()}`
  const listing = { id: `e2e-import-${key}`, name: `E2E ${label} ${key.slice(-5)}`, slug: key }
  runStatements(
    listingStatements({
      beforeApproval: logoUrl
        ? [
            insert('listing_media', {
              kind: 'logo',
              listing_id: listing.id,
              sort_order: 0,
              url: logoUrl
            })
          ]
        : [],
      category,
      row: {
        checksum: `e2e-${key}`,
        content: 'It came from the one-time JSON import.',
        description: 'An imported listing for the admin panel suite.',
        id: listing.id,
        name: listing.name,
        published_at: '2026-05-16',
        slug: listing.slug,
        source_identity: listing.slug,
        source_kind: 'legacy-json-migration-v1',
        website: `https://www.${key}.example`
      }
    })
  )
  return listing
}

/** The category `seedAdminCatalog` adds. */
export function activeCategory(): string {
  return adminCategory.slug
}

export interface Client {
  headers: Record<string, string>
  request: APIRequestContext
}

export function client(request: APIRequestContext, baseURL: string | undefined): Client {
  if (!baseURL) throw new Error('Playwright baseURL is required.')
  return {
    headers: { 'cf-connecting-ip': uniqueIp(), origin: new URL(baseURL).origin },
    request
  }
}

/** Signs in with the local dev code sender (docs/accounts.md). */
export async function signIn({ headers, request }: Client, email: string): Promise<void> {
  const requested = await request.post('/api/auth/email-otp/send-verification-otp', {
    data: { email, type: 'sign-in' },
    headers
  })
  expect(requested.status(), await requested.text()).toBe(200)
  const outbox = await request.get(`/api/auth/dev/otp-outbox?email=${encodeURIComponent(email)}`)
  const { otp } = (await outbox.json()) as { otp: string | null }
  expect(otp).toMatch(/^\d{6}$/u)
  const signedIn = await request.post('/api/auth/sign-in/email-otp', {
    data: { email, otp },
    headers
  })
  expect(signedIn.status(), await signedIn.text()).toBe(200)
}

/**
 * The email prefix of each suite that adds admins to the shared admin Worker's D1. Suites run in
 * parallel, so each clears only its own leftovers (`removeLeftoverAdmins`), never another's live
 * admin (#102 review round 2). Prefixes must not be prefixes of one another.
 */
export const ADMIN_EMAIL_PREFIXES = {
  accountDashboard: 'e2e-account-admin',
  adminPanel: 'e2e-panel-admin',
  billing: 'e2e-billing-admin',
  adminPanelAdded: 'e2e-panel-added',
  claims: 'e2e-claims-admin'
} as const

export type AdminEmailPrefix = (typeof ADMIN_EMAIL_PREFIXES)[keyof typeof ADMIN_EMAIL_PREFIXES]

/** Allowlist rows an interrupted run of this suite left behind, by its prefixes. */
export function removeLeftoverAdmins(
  prefixes: readonly AdminEmailPrefix[],
  server: SuiteServer = adminServer
): void {
  for (const prefix of prefixes) {
    localD1(`DELETE FROM admin_allowlist WHERE email LIKE ${q(`${prefix}-%@example.com`)}`, server)
  }
}

/**
 * A fresh admin for this test: its email goes on the allowlist before its first sign-in, so the
 * session gets the admin role. A fresh address keeps runs clear of the per-email code limits
 * that `devin@serp.co` shares across runs.
 */
export async function signInAsNewAdmin(
  account: Client,
  prefix: AdminEmailPrefix,
  server: SuiteServer = adminServer
): Promise<string> {
  const email = `${prefix}-${unique()}@example.com`
  localD1(`INSERT INTO admin_allowlist (email, added_by) VALUES (${q(email)}, 'e2e')`, server)
  await signIn(account, email)
  return email
}

export function removeAdmin(email: string, server: SuiteServer = adminServer): void {
  localD1(`DELETE FROM admin_allowlist WHERE email = ${q(email)}`, server)
}

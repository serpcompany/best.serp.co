import { readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { type APIRequestContext, expect } from '@playwright/test'

/**
 * The admin panel suite (serpcompany/best.serp.co#64) runs on its own local Worker with its own
 * D1, which `playwright.config.ts` starts from the already-built Worker: the suite publishes and
 * unpublishes listings, which would change the imported catalog the smoke suite counts exactly.
 * Helpers here run SQL on that D1, seed fixture submissions, and sign in a fresh admin. Never
 * used against a deployed Worker.
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

export function adminOrigin(server: SuiteServer = adminServer): string {
  return `http://127.0.0.1:${server.port}`
}

/** Serves the built Worker on a fresh, migrated D1 of its own (seeded by the suite). */
export function adminServerCommand(server: SuiteServer = adminServer): string {
  const state = server.stateDirectory
  return [
    'cd ../..',
    `rm -rf "${state}"`,
    `mkdir -p "${state}"`,
    `HARNESS_D1_STATE_DIRECTORY="${state}" pnpm db:migrate:local`,
    `HARNESS_D1_STATE_DIRECTORY="${state}" PORT=${server.port} pnpm tsx scripts/d1-local-preview.ts`
  ].join(' && ')
}

function stateRoot(server: SuiteServer): string {
  return resolve(server.stateDirectory, 'drizzle', 'best-serp-co')
}

/** The publication state and one category the suite's submissions use. */
export function seedAdminCatalog(server: SuiteServer = adminServer): void {
  localD1(
    `
    INSERT OR IGNORE INTO publication_state (id, version, checksum) VALUES (1, 0, 'e2e-admin');
    INSERT OR IGNORE INTO categories (slug, name, description, sort_order)
      VALUES ('e2e-tools', 'E2E Tools', 'Tools for the admin panel suite.', 0);
  `,
    server
  )
}

/**
 * The admin Worker's D1 file. Miniflare keeps each local D1 database as one SQLite file in WAL
 * mode, which this process can share with workerd.
 */
function databaseFile(server: SuiteServer): string {
  const directory = resolve(stateRoot(server), 'v3', 'd1', 'miniflare-D1DatabaseObject')
  const files = readdirSync(directory).filter(
    name => name.endsWith('.sqlite') && name !== 'metadata.sqlite'
  )
  if (files.length !== 1) {
    throw new Error(`Expected one local D1 database in ${directory}; found ${files.length}.`)
  }
  return resolve(directory, files[0] as string)
}

/**
 * Runs SQL on the admin Worker's local D1 and returns the rows of a single query. It opens the
 * SQLite file directly: `wrangler d1 execute` would start a second Miniflare per call, which
 * takes seconds each.
 */
export function localD1<T = Record<string, unknown>>(
  sql: string,
  server: SuiteServer = adminServer
): T[] {
  const database = new DatabaseSync(databaseFile(server))
  try {
    database.exec('PRAGMA busy_timeout = 10000; PRAGMA foreign_keys = ON;')
    const trimmed = sql.trim()
    if (/^(?:SELECT|WITH)\b/iu.test(trimmed) && !trimmed.replace(/;\s*$/u, '').includes(';')) {
      return database.prepare(trimmed).all() as T[]
    }
    database.exec(trimmed)
    return []
  } finally {
    database.close()
  }
}

/** SQL string literal. */
export function q(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

export function unique(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
}

/** A documentation-range client IP per request context, for the local sign-in limits. */
function uniqueIp(): string {
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
  localD1(`
    INSERT INTO listings (id, slug, name, description, website, content, status, published_at,
      source_kind, source_identity, checksum)
    VALUES (${q(listing.id)}, ${q(listing.slug)}, ${q(listing.name)},
      'An imported listing for the admin panel suite.', ${q(`https://www.${key}.example`)},
      'It came from the one-time JSON import.', 'draft', '2026-05-16',
      'legacy-json-migration-v1', ${q(listing.slug)}, ${q(`e2e-${key}`)});
    INSERT INTO listing_categories (listing_id, category_id, sort_order, is_primary)
      SELECT ${q(listing.id)}, id, 0, 1 FROM categories WHERE slug = ${q(category)};
    ${
      logoUrl
        ? `INSERT INTO listing_media (listing_id, kind, url, sort_order)
            VALUES (${q(listing.id)}, 'logo', ${q(logoUrl)}, 0);`
        : ''
    }
    UPDATE listings SET status = 'approved' WHERE id = ${q(listing.id)};
  `)
  return listing
}

/** The category `seedAdminCatalog` adds. */
export function activeCategory(): string {
  return 'e2e-tools'
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

/** Signs in with the local dev code sender (docs/ACCOUNTS.md). */
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
  adminPanelAdded: 'e2e-panel-added'
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

import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { MessageChannel, type MessagePort, receiveMessageOnPort, Worker } from 'node:worker_threads'
import { type APIRequestContext, expect } from '@playwright/test'
import {
  insert,
  listingStatements,
  type SeedStatement,
  type SeedValue,
  suiteCatalogStatements
} from './fixture-seed'
import { BILLING_PREVIEW_VARS } from './orders-worker'

/**
 * The admin panel suite (serpcompany/best.serp.co#64) runs on its own local Worker with its own
 * D1, which `playwright.config.ts` starts from the already-built Worker: the suite publishes and
 * unpublishes listings, which would change the seeded catalog the smoke suite counts exactly.
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
    `HARNESS_D1_STATE_DIRECTORY="${state}" ${previewVars}PORT=${server.port} pnpm tsx scripts/d1-local-preview.ts`
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

/** The suite Workers' local D1 (`d1_databases` in `wrangler.jsonc`, `project.local.databaseId`). */
const LOCAL_D1_DATABASE_ID = 'local-only-do-not-deploy'

/** The thread that makes `postSync`'s requests, and the count of replies it has posted. */
interface Requester {
  port: MessagePort
  replies: Int32Array
}

interface Reply {
  error?: string
  id: number
  text?: string
}

let requester: Requester | undefined
let requests = 0

/** Posts JSON, replies with the body text or the error, then counts the reply. */
const REQUESTER_SOURCE = `
const { workerData } = require('node:worker_threads')
const { port, replies } = workerData
port.on('message', async ({ body, id, url }) => {
  let reply
  try {
    const response = await fetch(url, {
      body,
      headers: { 'content-type': 'application/json' },
      method: 'POST'
    })
    reply = { id, text: await response.text() }
  } catch (error) {
    reply = { error: String(error), id }
  }
  port.postMessage(reply)
  Atomics.add(replies, 0, 1)
  Atomics.notify(replies, 0)
})`

function startRequester(): Requester {
  const replies = new Int32Array(new SharedArrayBuffer(4))
  const { port1, port2 } = new MessageChannel()
  new Worker(REQUESTER_SOURCE, {
    eval: true,
    transferList: [port2],
    workerData: { port: port2, replies }
  }).unref()
  port1.unref()
  return { port: port1, replies }
}

/**
 * POSTs JSON synchronously, as the helpers here are synchronous: one worker thread per test
 * process makes each request while this thread waits for its reply.
 */
function postSync(url: string, body: string): string {
  requester ??= startRequester()
  const { port, replies } = requester
  const id = ++requests
  port.postMessage({ body, id, url })
  const deadline = Date.now() + 30_000
  for (;;) {
    const seen = Atomics.load(replies, 0)
    const received = receiveMessageOnPort(port)
    if (received) {
      const reply = received.message as Reply
      // A late reply to a request that timed out.
      if (reply.id !== id) continue
      if (reply.text === undefined) throw new Error(`${url} failed: ${reply.error}`)
      return reply.text
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error(`No answer from ${url} in 30 seconds.`)
    Atomics.wait(replies, 0, seen, remaining)
  }
}

interface D1QueryAnswer {
  errors?: { message?: string }[]
  result?: { results?: { columns: string[]; rows: unknown[][] } }[] | null
  success?: boolean
}

/**
 * Runs SQL on a suite Worker's local D1 through the Worker's own Miniflare: Wrangler's local
 * explorer API (`/cdn-cgi/local/explorer/api/d1/database/<id>/raw`), which reaches the same D1
 * Durable Object as the Worker's binding, so the two take turns. Never the SQLite file from this
 * process: Miniflare fails a Worker's D1 query, as "internal error", when another process writes
 * the file at the same moment, and the admin pages showed it as React #441 (#204). A `sql` of
 * several statements runs as one batch; so does `batch`, in one transaction.
 */
function suiteD1(server: SuiteServer, body: { batch: { sql: string }[] } | { sql: string }) {
  const url = `${adminOrigin(server)}/cdn-cgi/local/explorer/api/d1/database/${LOCAL_D1_DATABASE_ID}/raw`
  const output = postSync(url, JSON.stringify(body))
  let answer: D1QueryAnswer
  try {
    answer = JSON.parse(output) as D1QueryAnswer
  } catch {
    throw new Error(`Local D1 on port ${server.port} answered ${output.slice(0, 200)}`)
  }
  if (!answer.success || !answer.result) {
    const reasons = answer.errors?.map(error => error.message).join('; ')
    throw new Error(`Local D1 on port ${server.port} refused the query: ${reasons || output}`)
  }
  return answer.result
}

/** `value` as SQL: the explorer API binds only text, so numbers and NULL are written inline. */
function sqlLiteral(value: SeedValue): string {
  if (value === null) return 'NULL'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Cannot write ${value} to local D1.`)
    return String(value)
  }
  return q(value)
}

/** The statement with each `?` outside quoted text replaced by its parameter's literal. */
function inlineParameters({ params, sql }: SeedStatement): string {
  let quote: string | null = null
  let next = 0
  let inlined = ''
  for (const character of sql) {
    if (quote) {
      if (character === quote) quote = null
    } else if (character === "'" || character === '"') {
      quote = character
    } else if (character === '?') {
      if (next >= params.length) throw new Error(`Too few parameters for: ${sql}`)
      inlined += sqlLiteral(params[next++] as SeedValue)
      continue
    }
    inlined += character
  }
  if (next !== params.length) throw new Error(`Too many parameters for: ${sql}`)
  return inlined
}

/**
 * Runs SQL on a suite Worker's local D1 (the admin Worker's by default) and returns the rows of a
 * single query. Rows built from values go through `runStatements` instead.
 */
export function localD1<T = Record<string, unknown>>(
  sql: string,
  server: SuiteServer = adminServer
): T[] {
  const trimmed = sql.trim()
  const [answer] = suiteD1(server, { sql: trimmed })
  if (!/^(?:SELECT|WITH)\b/iu.test(trimmed) || trimmed.replace(/;\s*$/u, '').includes(';')) {
    return []
  }
  const { columns, rows } = answer?.results ?? { columns: [], rows: [] }
  return rows.map(row => Object.fromEntries(columns.map((name, i) => [name, row[i]])) as T)
}

/**
 * Runs bound statements (`fixture-seed.ts`'s builders) on a suite Worker's local D1, in one
 * transaction, the way `localD1` reaches it.
 */
export function runStatements(
  statements: readonly SeedStatement[],
  server: SuiteServer = adminServer
): void {
  if (statements.length === 0) return
  suiteD1(server, { batch: statements.map(statement => ({ sql: inlineParameters(statement) })) })
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

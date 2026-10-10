/**
 * ARCHIVED (serpcompany/best.serp.co#315): the bootstrap-parity half of
 * `scripts/d1-table-inventory.ts`, cut from it as it was before #315. `db:verify:local` and
 * `cloudflare-release.ts verify-import` compared these tables with the v1 import. History only:
 * not built, linted, or run.
 */
import type { ApplicationTableName } from './d1-table-inventory'
import { applicationTableNames } from './d1-table-inventory'

/**
 * Tables written at runtime: Better Auth and its sign-in limits (#60), the transactional email
 * ledger (#71), the media ingestion queue (#95), and claim holds (#67: seeded by migration from
 * the live catalog, then cleared by admins). They belong to the exact schema inventory,
 * but not to bootstrap parity: the import never writes them, and a database that has served a
 * sign-in, sent an email, or ingested an image (local preview, Playwright, a deployed Worker)
 * holds rows.
 */
export const runtimeTableNames = [
  'users',
  'sessions',
  'accounts',
  'verification',
  'auth_rate_limit_hits',
  'email_deliveries',
  'media_ingestions',
  'listing_claim_holds'
] as const satisfies readonly ApplicationTableName[]

export type ParityTableName = Exclude<ApplicationTableName, (typeof runtimeTableNames)[number]>

/** Tables whose rows bootstrap parity (`db:verify:local`, `verify-import`) compares exactly. */
export const parityTableNames = applicationTableNames.filter(
  (table): table is ParityTableName => !(runtimeTableNames as readonly string[]).includes(table)
)

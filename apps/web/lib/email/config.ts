/**
 * What transactional email may do in each environment, read from explicit Worker vars (the
 * same rule as `../environment/site-environment.ts`: nothing is inferred from the host).
 *
 * - local: nothing is sent; each message is written to the Worker log.
 * - staging: subjects start with `[staging]`, and mail goes only to the recipients listed in
 *   `EMAIL_STAGING_ALLOWLIST` (comma-separated; empty or missing means nobody).
 * - production: mail goes to any valid recipient.
 *
 * An unknown, missing, or mismatched `SITE_ENVIRONMENT` / `D1_RUNTIME_ENV` disables email
 * (fail closed). This module has no Next.js or `server-only` imports, so the Worker entry (a
 * future cron handler) can use it as well as route handlers.
 */
import { site } from '@serpdirectory/site-config'
import {
  CANONICAL_ORIGIN,
  parseSiteEnvironment,
  type SiteEnvironment
} from '../environment/site-environment'

/**
 * The sender every email uses (`SERP Directory <noreply@mail.serp.co>`, from site-config). The
 * `EMAIL` binding in `wrangler.jsonc` may send only from this address.
 */
export const EMAIL_FROM: Readonly<{ email: string; name: string }> = {
  email: site.email.from.address,
  name: site.email.from.name
}

/** The contact address emails name in their footer (`support@serp.co`). */
export const EMAIL_SUPPORT_ADDRESS = site.email.supportAddress

export const STAGING_SUBJECT_PREFIX = '[staging]'

/** The var that lists the recipients staging may email. */
export const STAGING_ALLOWLIST_VAR = 'EMAIL_STAGING_ALLOWLIST'

/**
 * The origin each environment's email links point at. Links are absolute so they work in any
 * mail client; staging links stay on staging. Local links assume `pnpm dev` (port 8787).
 */
export const EMAIL_LINK_ORIGINS: Readonly<Record<SiteEnvironment, string>> = {
  local: 'http://localhost:8787',
  production: CANONICAL_ORIGIN,
  staging: 'https://best-serp-co-staging.serpcompany.workers.dev'
}

export class EmailConfigError extends Error {
  override name = 'EmailConfigError'
}

export interface EmailEnvironmentVars {
  D1_RUNTIME_ENV?: unknown
  EMAIL_STAGING_ALLOWLIST?: unknown
  SITE_ENVIRONMENT?: unknown
}

export interface EmailPolicy {
  /** `log` writes each message to the Worker log instead of sending it (local only). */
  delivery: 'log' | 'provider'
  environment: SiteEnvironment
  linkOrigin: string
  /** Staging only: the recipients mail may go to. `null` allows every valid recipient. */
  recipientAllowlist: ReadonlySet<string> | null
  /** Prepended to every subject, followed by a space (`[staging]` on staging). */
  subjectPrefix: string | null
}

const MAX_ADDRESS_LENGTH = 254
// One plain address: no display name, whitespace, comma, or angle bracket, so a recipient can
// never smuggle a second address or a header into the message.
const ADDRESS_PATTERN =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u

/** The address in lower case, or null unless it is one plain, valid address. */
export function normalizeEmailAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const address = value.trim().toLowerCase()
  if (address.length > MAX_ADDRESS_LENGTH || !ADDRESS_PATTERN.test(address)) return null
  return address
}

/** The part after `@`, the only piece of a recipient that logs ever carry. */
export function recipientDomain(address: string): string {
  return address.slice(address.lastIndexOf('@') + 1)
}

/** Parses `EMAIL_STAGING_ALLOWLIST`; a malformed entry is a configuration error. */
export function parseRecipientAllowlist(value: unknown): ReadonlySet<string> {
  if (value === undefined || value === null) return new Set()
  if (typeof value !== 'string') {
    throw new EmailConfigError(`${STAGING_ALLOWLIST_VAR} must be a comma-separated string.`)
  }
  const entries = value
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean)
  const addresses = new Set<string>()
  for (const entry of entries) {
    const address = normalizeEmailAddress(entry)
    if (!address) {
      throw new EmailConfigError(`${STAGING_ALLOWLIST_VAR} holds an invalid address.`)
    }
    addresses.add(address)
  }
  return addresses
}

/**
 * The policy for the configured environment. Throws `EmailConfigError` unless
 * `SITE_ENVIRONMENT` and `D1_RUNTIME_ENV` name the same known environment.
 */
export function resolveEmailPolicy(vars: EmailEnvironmentVars): EmailPolicy {
  const environment = parseSiteEnvironment(vars.SITE_ENVIRONMENT)
  const runtime = parseSiteEnvironment(vars.D1_RUNTIME_ENV)
  if (!environment || environment !== runtime) {
    throw new EmailConfigError(
      'Email is disabled: SITE_ENVIRONMENT and D1_RUNTIME_ENV must name the same environment (local, staging, or production).'
    )
  }
  const linkOrigin = EMAIL_LINK_ORIGINS[environment]
  if (environment === 'local') {
    return {
      delivery: 'log',
      environment,
      linkOrigin,
      recipientAllowlist: null,
      subjectPrefix: null
    }
  }
  if (environment === 'staging') {
    return {
      delivery: 'provider',
      environment,
      linkOrigin,
      recipientAllowlist: parseRecipientAllowlist(vars.EMAIL_STAGING_ALLOWLIST),
      subjectPrefix: STAGING_SUBJECT_PREFIX
    }
  }
  return {
    delivery: 'provider',
    environment,
    linkOrigin,
    recipientAllowlist: null,
    subjectPrefix: null
  }
}

/** True when the policy lets mail go to this (normalized) address. */
export function recipientAllowed(policy: EmailPolicy, address: string): boolean {
  return policy.recipientAllowlist === null || policy.recipientAllowlist.has(address)
}

export function prefixedSubject(policy: EmailPolicy, subject: string): string {
  return policy.subjectPrefix ? `${policy.subjectPrefix} ${subject}` : subject
}

/**
 * What transactional email may do in each environment, read from explicit Worker vars (the
 * same rule as `../environment/site-environment.ts`: nothing is inferred from the host).
 *
 * - local: nothing is sent; each message is written to the Worker log.
 * - staging: sent through useSend from `noreply@mail.serp.co`, like production (owner
 *   decision); subjects start with `[staging]`, and mail goes only to the recipients listed in
 *   `EMAIL_STAGING_ALLOWLIST` (comma-separated; empty or missing means nobody).
 * - production: sent through useSend from `noreply@mail.serp.co` to any valid recipient.
 *
 * An unknown, missing, or mismatched `SITE_ENVIRONMENT` / `D1_RUNTIME_ENV` disables email
 * (fail closed). This module has no Next.js or `server-only` imports, so the Worker entry (a
 * future cron handler) can use it as well as route handlers.
 */

import {
  CANONICAL_ORIGIN,
  parseSiteEnvironment,
  type SiteEnvironment
} from '../environment/site-environment'
import { site } from '../site/site'

export interface EmailSenderIdentity {
  email: string
  name: string
}

/**
 * The sender in every environment, from site-config: `SERP Directory <noreply@mail.serp.co>`.
 * Staging shares it (owner decision: the staging useSend key is restricted to `mail.serp.co`);
 * its `[staging]` subject prefix and recipient allowlist tell the two apart.
 */
export const EMAIL_SENDER: Readonly<EmailSenderIdentity> = Object.freeze({
  email: site.email.from.address,
  name: site.email.from.name
})

/** The Worker secret holding the useSend API key (staging and production). */
export const USESEND_API_KEY_SECRET = 'USESEND_API_KEY'
/** The Worker var holding the useSend instance origin (`https://app.usesend.com`). */
export const USESEND_BASE_URL_VAR = 'USESEND_BASE_URL'
/**
 * The only origins the API key may be sent to: hosted useSend (owner decision). Anything else
 * disables email instead of sending the key as a Bearer token to an unknown host.
 */
export const USESEND_ORIGINS: ReadonlySet<string> = new Set(['https://app.usesend.com'])

export interface UseSendConfig {
  apiKey: string
  /** The instance origin; the API lives under `/api`. */
  baseUrl: string
}

/**
 * The useSend settings from Worker bindings. Throws `EmailConfigError` (email is then disabled)
 * unless `USESEND_BASE_URL` is an allowed origin (`USESEND_ORIGINS`) and `USESEND_API_KEY` is
 * set.
 */
export function resolveUseSendConfig(env: {
  USESEND_API_KEY?: unknown
  USESEND_BASE_URL?: unknown
}): UseSendConfig {
  const rawBase = typeof env.USESEND_BASE_URL === 'string' ? env.USESEND_BASE_URL.trim() : ''
  const baseUrl = rawBase.replace(/\/$/u, '')
  if (!USESEND_ORIGINS.has(baseUrl)) {
    throw new EmailConfigError(
      `Email is disabled: ${USESEND_BASE_URL_VAR} must be ${[...USESEND_ORIGINS].join(' or ')}.`
    )
  }
  const apiKey = typeof env.USESEND_API_KEY === 'string' ? env.USESEND_API_KEY.trim() : ''
  if (!apiKey || apiKey.length > 512 || /[\s\p{Cc}]/u.test(apiKey)) {
    throw new EmailConfigError(
      `Email is disabled: the ${USESEND_API_KEY_SECRET} secret is not set.`
    )
  }
  return { apiKey, baseUrl }
}

/**
 * The dashboard every user email footer links to (`/account/`; `/account/messages/` once #73
 * adds the inbox). The sender is not monitored and emails carry no Reply-To; replies happen in
 * the dashboard (serpcompany/best.serp.co#73).
 */
export const EMAIL_DASHBOARD_PATH = site.email.dashboardPath

/**
 * The page admin email footers link to: the review queue (`/admin/submissions/`, #64), and
 * `/admin/inbox/` once #73 lands.
 */
export const EMAIL_ADMIN_DASHBOARD_PATH = site.email.adminDashboardPath

/**
 * The address admin alerts go to (`devin@serp.co`, serpcompany/best.serp.co#59). Callers pass
 * it as the recipient; templates never hold an address.
 */
export const EMAIL_ADMIN_RECIPIENT = site.email.adminRecipient

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
  from: Readonly<EmailSenderIdentity>
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
  const from = EMAIL_SENDER
  if (environment === 'local') {
    return {
      delivery: 'log',
      environment,
      from,
      linkOrigin,
      recipientAllowlist: null,
      subjectPrefix: null
    }
  }
  if (environment === 'staging') {
    return {
      delivery: 'provider',
      environment,
      from,
      linkOrigin,
      recipientAllowlist: parseRecipientAllowlist(vars.EMAIL_STAGING_ALLOWLIST),
      subjectPrefix: STAGING_SUBJECT_PREFIX
    }
  }
  return {
    delivery: 'provider',
    environment,
    from,
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

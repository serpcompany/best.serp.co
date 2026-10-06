import {
  CLAIM_BADGE_COOLDOWN_SECONDS,
  CLAIM_BADGE_MAX_ATTEMPTS,
  CLAIM_CODE_MAX_ATTEMPTS,
  CLAIM_LOCK_MINUTES,
  CLAIM_RESEND_COOLDOWN_SECONDS,
  CLAIM_VERIFIED_TTL_HOURS,
  type ClaimListing,
  type ClaimOperations,
  type ListingClaim
} from '@serpdirectory/data-ops/claims'
import type { ListingClaimMethod } from '@serpdirectory/data-ops/schema'
import { CONCLUSIVE_VERIFICATION_FAILURES } from '@serpdirectory/data-ops/submissions'
import { CLAIM_CODE_LENGTH, CLAIM_CODE_TTL_SECONDS } from '../email/emails/codes'
import type { BadgeVerificationResult } from '../submissions/badge-verifier'
import { checkClaimAddress, claimBlockKeys, screenClaimAddress } from './address'
import { type ProductSite, productSite, type ResolveLanding } from './product'

/**
 * The claim flow (serpcompany/best.serp.co#59, #67; #70 screen 8's order: method → work email →
 * code → badge check or payment → done, so nobody pays before proving the address):
 *
 * 1. `startClaim`: a live, ownerless, unblocked listing; an address on its registrable domain,
 *    not webmail; then a single-use 6-digit code by email (`claim-code`, through the email
 *    ledger), valid `CLAIM_CODE_TTL_SECONDS`. Asking again sends a new code, at most one per
 *    `CLAIM_RESEND_COOLDOWN_SECONDS`.
 * 2. `confirmClaimEmail`: the code, in time. Each wrong code uses one of
 *    `CLAIM_CODE_MAX_ATTEMPTS`; the last burns it and locks the claim for `CLAIM_LOCK_MINUTES`.
 * 3. `checkClaimBadge` (free): the badge on the website, as the submit flow checks it (#63);
 *    a pass makes the claimer the owner (`badge_claim`), and the weekly badge program (#66) then
 *    checks the listing, removing the owner if the badge is confirmed missing.
 *    `completePaidClaim` (#68): a recorded payment makes the claimer the owner (`paid_claim`);
 *    the badge is then optional and never checked.
 *
 * A listing with an owner refuses every step (`already_owned`, with the contact path). Codes are
 * kept only as an HMAC under a key derived from the auth secret, bound to the claim.
 */

export interface ClaimDependencies {
  /** HMAC key for codes (derived from the auth secret). */
  codeKey: string
  /** Where someone who believes they own an owned listing gets in touch. */
  contactPath: string
  now: () => Date
  operations: ClaimOperations
  /** Whether paid claims (#68) are on. */
  paidClaims: boolean
  /** Follows a listing link (`serp.ly`) to its landing page (`./product.ts`). */
  resolveLanding: ResolveLanding
  /**
   * Counts one code send against the per-recipient, per-domain, and per-listing caps (#108 review
   * round 1); null when allowed.
   */
  sendBudget(input: {
    address: string
    domain: string
    listingId: string
  }): Promise<{ retryAfterSeconds: number } | null>
  /** Sends the code; resolves once queued. `codesSent` keys the email ledger. */
  sendCode(input: {
    claimId: string
    code: string
    codesSent: number
    listingName: string
    to: string
  }): Promise<void>
}

export interface ClaimView {
  /** Wrong codes still allowed for the current code. */
  attemptsLeft: number
  /** Badge checks that can still find a result (of `CLAIM_BADGE_MAX_ATTEMPTS`). */
  checksLeft: number
  codeExpiresAt: string
  /** The address the code went to. */
  email: string
  id: string
  listing: { name: string; slug: string }
  lockedUntil: string | null
  method: ListingClaimMethod
  /** When another code can be asked for. */
  resendAvailableAt: string
  status: ListingClaim['status']
}

export type ClaimFailureCode =
  | 'already_owned'
  | 'checks_used'
  | 'no_product_domain'
  | 'not_owner'
  | 'review_required'
  | 'blocked'
  | 'changed'
  | 'code_expired'
  | 'confirmation_expired'
  | 'cooldown'
  | 'domain_mismatch'
  | 'invalid_code'
  | 'invalid_email'
  | 'invalid_method'
  | 'not_confirmed'
  | 'not_found'
  | 'too_many_attempts'
  | 'webmail'

export interface ClaimFailure {
  attemptsLeft?: number
  code: ClaimFailureCode
  /** Set for `already_owned` and `review_required`. */
  contactPath?: string
  ok: false
  retryAfterSeconds?: number
  status: 404 | 409 | 410 | 422 | 429
}

export type ClaimResult<T> = ClaimFailure | ({ ok: true } & T)

const SECOND = 1000
const MINUTE = 60 * SECOND

function fail(
  status: ClaimFailure['status'],
  code: ClaimFailureCode,
  extra: Partial<ClaimFailure> = {}
): ClaimFailure {
  return { code, ok: false, status, ...extra }
}

function secondsUntil(instant: string | Date, now: Date): number {
  const time = typeof instant === 'string' ? Date.parse(instant) : instant.getTime()
  return Math.max(1, Math.ceil((time - now.getTime()) / SECOND))
}

function view(claim: ListingClaim, listing: { name: string; slug: string }): ClaimView {
  return {
    attemptsLeft: Math.max(0, CLAIM_CODE_MAX_ATTEMPTS - claim.attempts),
    checksLeft: Math.max(0, CLAIM_BADGE_MAX_ATTEMPTS - claim.badgeAttempts),
    codeExpiresAt: claim.codeExpiresAt,
    email: claim.email,
    id: claim.id,
    listing: { name: listing.name, slug: listing.slug },
    lockedUntil: claim.lockedUntil,
    method: claim.method,
    resendAvailableAt: new Date(
      Date.parse(claim.codeSentAt) + CLAIM_RESEND_COOLDOWN_SECONDS * SECOND
    ).toISOString(),
    status: claim.status
  }
}

/** A uniformly random 6-digit code. */
export function generateClaimCode(): string {
  const limit = 10 ** CLAIM_CODE_LENGTH
  // Rejection sampling keeps every code equally likely.
  const ceiling = Math.floor(0x1_0000_0000 / limit) * limit
  const value = new Uint32Array(1)
  do crypto.getRandomValues(value)
  while ((value[0] as number) >= ceiling)
  return String((value[0] as number) % limit).padStart(CLAIM_CODE_LENGTH, '0')
}

/** HMAC-SHA256 of the code bound to its claim, as hex. */
export async function hashClaimCode(key: string, claimId: string, code: string): Promise<string> {
  const encoder = new TextEncoder()
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { hash: 'SHA-256', name: 'HMAC' },
    false,
    ['sign']
  )
  const digest = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(`${claimId}:${code}`))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

function owned(deps: ClaimDependencies): ClaimFailure {
  return fail(409, 'already_owned', { contactPath: deps.contactPath })
}

/** A listing whose ownership the owner decides: the claimer gets in touch instead. */
function review(deps: Pick<ClaimDependencies, 'contactPath'>): ClaimFailure {
  return fail(409, 'review_required', { contactPath: deps.contactPath })
}

/** The listing a claim may target, or why not. */
async function claimableListing(
  deps: ClaimDependencies,
  by: { id: string } | { slug: string },
  /** A refusal decided before anything is fetched (the address itself). */
  screen: () => ClaimFailure | null = () => null
): Promise<ClaimResult<{ listing: ClaimListing; site: ProductSite }>> {
  const listing = await deps.operations.listing(by)
  if (!listing?.live) return fail(404, 'not_found')
  if (listing.ownerUserId) return owned(deps)
  // #100's owner-review sets, and anything an admin holds: the owner decides, not a claim.
  if (await deps.operations.held(listing.id)) return review(deps)
  const screened = screen()
  if (screened) return screened
  const resolved = await productSite(listing, deps.resolveLanding)
  if (!resolved.ok) {
    return resolved.reason === 'review' ? review(deps) : fail(409, 'no_product_domain')
  }
  const { site } = resolved
  if (await deps.operations.blocked(claimBlockKeys(site))) return fail(409, 'blocked')
  return { listing, ok: true, site }
}

export async function startClaim(
  deps: ClaimDependencies,
  input: { email: string; listingSlug: string; method: string; userId: string }
): Promise<ClaimResult<{ claim: ClaimView }>> {
  const method = input.method
  if (method !== 'badge' && !(method === 'paid' && deps.paidClaims)) {
    return fail(422, 'invalid_method')
  }
  // A malformed, webmail, or SERP address is refused before the listing's link is followed.
  const screened = screenClaimAddress(input.email)
  const target = await claimableListing(deps, { slug: input.listingSlug }, () =>
    screened ? fail(422, screened) : null
  )
  if (!target.ok) return target
  const { listing, site } = target
  const address = checkClaimAddress(input.email, site.domain)
  if (!address.ok) return fail(422, address.problem)

  const now = deps.now()
  const at = now.toISOString()
  const existing = await deps.operations.openClaim({ listingId: listing.id, userId: input.userId })
  if (existing?.lockedUntil && Date.parse(existing.lockedUntil) > now.getTime()) {
    return fail(429, 'too_many_attempts', {
      retryAfterSeconds: secondsUntil(existing.lockedUntil, now)
    })
  }
  const resendAt = existing
    ? Date.parse(existing.codeSentAt) + CLAIM_RESEND_COOLDOWN_SECONDS * SECOND
    : 0
  if (existing && resendAt > now.getTime()) {
    return fail(429, 'cooldown', { retryAfterSeconds: secondsUntil(new Date(resendAt), now) })
  }
  const capped = await deps.sendBudget({
    address: address.address,
    domain: address.domain,
    listingId: listing.id
  })
  if (capped) return fail(429, 'cooldown', { retryAfterSeconds: capped.retryAfterSeconds })

  const claimId = existing?.id ?? crypto.randomUUID()
  const code = generateClaimCode()
  const codeInput = {
    codeExpiresAt: new Date(now.getTime() + CLAIM_CODE_TTL_SECONDS * SECOND).toISOString(),
    codeHash: await hashClaimCode(deps.codeKey, claimId, code),
    email: address.address,
    emailDomain: address.domain,
    method,
    listingWebsite: listing.website,
    now: at,
    productUrl: site.url
  } as const
  const written = existing
    ? await deps.operations.resend({ ...codeInput, claimId, userId: input.userId })
    : await deps.operations.start({
        ...codeInput,
        claimId,
        listingId: listing.id,
        userId: input.userId
      })
  if (!written) {
    const current = await deps.operations.listing({ id: listing.id })
    if (current?.ownerUserId) return owned(deps)
    return fail(409, 'changed')
  }
  const claim = await deps.operations.claim({ claimId, userId: input.userId })
  if (!claim) return fail(409, 'changed')
  await deps.sendCode({
    claimId,
    code,
    codesSent: claim.codesSent,
    listingName: listing.name,
    to: address.address
  })
  return { claim: view(claim, listing), ok: true }
}

/** The claimer's claim and its listing, or why it can't go on. */
async function ownClaim(
  deps: ClaimDependencies,
  input: { claimId: string; userId: string }
): Promise<ClaimResult<{ claim: ListingClaim; listing: ClaimListing }>> {
  const claim = await deps.operations.claim(input)
  if (!claim) return fail(404, 'not_found')
  const listing = await deps.operations.listing({ id: claim.listingId })
  if (!listing) return fail(404, 'not_found')
  if (claim.status === 'cancelled') {
    return listing.ownerUserId ? owned(deps) : fail(409, 'changed')
  }
  return { claim, listing, ok: true }
}

export async function confirmClaimEmail(
  deps: ClaimDependencies,
  input: { claimId: string; code: string; userId: string }
): Promise<ClaimResult<{ claim: ClaimView }>> {
  const found = await ownClaim(deps, input)
  if (!found.ok) return found
  const { claim, listing } = found
  // Confirmed already (a repeated request): nothing to spend.
  if (claim.status !== 'code_sent') return { claim: view(claim, listing), ok: true }
  if (listing.ownerUserId) return owned(deps)
  const now = deps.now()
  if (claim.lockedUntil && Date.parse(claim.lockedUntil) > now.getTime()) {
    return fail(429, 'too_many_attempts', {
      retryAfterSeconds: secondsUntil(claim.lockedUntil, now)
    })
  }
  if (!claim.codePending || Date.parse(claim.codeExpiresAt) <= now.getTime()) {
    return fail(410, 'code_expired')
  }
  const code = input.code.replace(/\s+/gu, '')
  const at = now.toISOString()
  if (/^\d{6}$/u.test(code)) {
    const confirmed = await deps.operations.confirmEmail({
      claimId: claim.id,
      codeHash: await hashClaimCode(deps.codeKey, claim.id, code),
      now: at,
      userId: input.userId
    })
    if (confirmed) {
      const updated = await deps.operations.claim(input)
      return updated ? { claim: view(updated, listing), ok: true } : fail(409, 'changed')
    }
  }
  const lockedUntil = new Date(now.getTime() + CLAIM_LOCK_MINUTES * MINUTE).toISOString()
  await deps.operations.recordWrongCode({
    claimId: claim.id,
    lockedUntil,
    now: at,
    userId: input.userId
  })
  const after = await deps.operations.claim(input)
  if (after?.lockedUntil && Date.parse(after.lockedUntil) > now.getTime()) {
    return fail(429, 'too_many_attempts', {
      retryAfterSeconds: secondsUntil(after.lockedUntil, now)
    })
  }
  if (after && !after.codePending) return fail(410, 'code_expired')
  return fail(422, 'invalid_code', {
    attemptsLeft: Math.max(
      0,
      CLAIM_CODE_MAX_ATTEMPTS - (after?.attempts ?? CLAIM_CODE_MAX_ATTEMPTS)
    )
  })
}

/**
 * True while the listing's product domain is still the one the claim's address proved. The claim
 * stores the domain and the website it came from, so nothing is fetched unless an admin changed
 * the website since (#108 review round 2): a fetch that fails then counts as a change.
 */
async function sameProductDomain(
  deps: Pick<ClaimDependencies, 'resolveLanding'>,
  claim: ListingClaim,
  listing: ClaimListing
): Promise<boolean> {
  if (listing.website === claim.listingWebsite) return true
  const resolved = await productSite(listing, deps.resolveLanding)
  return resolved.ok && resolved.site.domain === claim.emailDomain
}

function confirmationExpired(claim: ListingClaim, now: Date): boolean {
  return (
    !claim.emailVerifiedAt ||
    Date.parse(claim.emailVerifiedAt) < now.getTime() - CLAIM_VERIFIED_TTL_HOURS * 60 * MINUTE
  )
}

export async function checkClaimBadge(
  deps: ClaimDependencies & {
    /** Counts one check against the outbound budget; null when allowed. */
    budget(claimId: string): Promise<{ retryAfterSeconds: number } | null>
    /** Checks the badge on the claim's product page, pinned to the claim domain. */
    verifyBadge(claim: ListingClaim, listing: ClaimListing): Promise<BadgeVerificationResult>
  },
  input: { actor: string; claimId: string; userId: string }
): Promise<ClaimResult<{ claim: ClaimView; result: BadgeVerificationResult }>> {
  const found = await ownClaim(deps, input)
  if (!found.ok) return found
  const { claim, listing } = found
  if (claim.status === 'completed') {
    // A replay reports success only while the claim still gives ownership: the badge program
    // may have removed it since (#108 review round 1, finding 3).
    if (listing.ownerUserId === input.userId) {
      return { claim: view(claim, listing), ok: true, result: { ok: true } }
    }
    return listing.ownerUserId ? owned(deps) : fail(409, 'not_owner')
  }
  if (claim.method !== 'badge') return fail(422, 'invalid_method')
  if (claim.status !== 'email_verified') return fail(409, 'not_confirmed')
  if (listing.ownerUserId) return owned(deps)
  if (claim.badgeAttempts >= CLAIM_BADGE_MAX_ATTEMPTS) return fail(409, 'checks_used')
  const now = deps.now()
  if (confirmationExpired(claim, now)) return fail(410, 'confirmation_expired')
  // The listing's product domain may have changed since the code was sent (an admin edit).
  if (!(await sameProductDomain(deps, claim, listing))) return fail(409, 'changed')
  const started = await deps.operations.claimBadgeCheck({
    claimId: claim.id,
    now: now.toISOString(),
    userId: input.userId
  })
  if (!started) {
    const current = await deps.operations.listing({ id: listing.id })
    if (current?.ownerUserId) return owned(deps)
    if (!current?.live) return fail(404, 'not_found')
    const checked = claim.badgeCheckedAt ? Date.parse(claim.badgeCheckedAt) : now.getTime()
    return fail(429, 'cooldown', {
      retryAfterSeconds: secondsUntil(
        new Date(checked + CLAIM_BADGE_COOLDOWN_SECONDS * SECOND),
        now
      )
    })
  }
  const limited = await deps.budget(claim.id)
  if (limited) return fail(429, 'cooldown', { retryAfterSeconds: limited.retryAfterSeconds })
  let result: BadgeVerificationResult
  try {
    result = await deps.verifyBadge(claim, listing)
  } catch {
    result = { code: 'verification_service_error', ok: false }
  }
  if (!result.ok) {
    // A check that found a result uses one of the ten, as at submit (#63); an outage doesn't.
    if ((CONCLUSIVE_VERIFICATION_FAILURES as readonly string[]).includes(result.code)) {
      await deps.operations.recordBadgeMiss({
        claimId: claim.id,
        now: now.toISOString(),
        userId: input.userId
      })
    }
    const current = await deps.operations.claim(input)
    return { claim: view(current ?? claim, listing), ok: true, result }
  }
  const done = await deps.operations.complete({ actor: input.actor, claim, now: now.toISOString() })
  if (!done) {
    const current = await deps.operations.listing({ id: listing.id })
    if (current?.ownerUserId) return owned(deps)
    return (await deps.operations.held(listing.id)) ? review(deps) : fail(409, 'changed')
  }
  const completed = await deps.operations.claim(input)
  return { claim: view(completed ?? claim, listing), ok: true, result }
}

/**
 * Completes a confirmed paid claim once its payment is recorded (#68's webhook calls this;
 * nothing does while `features.orders` is off). The claimer becomes the owner (`paid_claim`).
 */
export async function completePaidClaim(
  deps: Pick<
    ClaimDependencies,
    'contactPath' | 'now' | 'operations' | 'paidClaims' | 'resolveLanding'
  >,
  input: { actor: string; claimId: string; userId: string }
): Promise<ClaimResult<{ completed: boolean }>> {
  if (!deps.paidClaims) return fail(404, 'not_found')
  const claim = await deps.operations.claim(input)
  if (!claim) return fail(404, 'not_found')
  if (claim.status === 'completed') return { completed: true, ok: true }
  if (claim.status === 'cancelled') {
    const listing = await deps.operations.listing({ id: claim.listingId })
    return listing?.ownerUserId
      ? fail(409, 'already_owned', { contactPath: deps.contactPath })
      : fail(409, 'changed')
  }
  if (claim.method !== 'paid') return fail(422, 'invalid_method')
  if (claim.status !== 'email_verified') return fail(409, 'not_confirmed')
  const now = deps.now()
  if (confirmationExpired(claim, now)) return fail(410, 'confirmation_expired')
  const current = await deps.operations.listing({ id: claim.listingId })
  if (!current) return fail(404, 'not_found')
  if (current.ownerUserId) return fail(409, 'already_owned', { contactPath: deps.contactPath })
  if (!(await sameProductDomain(deps, claim, current))) return fail(409, 'changed')
  const done = await deps.operations.complete({ actor: input.actor, claim, now: now.toISOString() })
  if (done) return { completed: true, ok: true }
  const listing = await deps.operations.listing({ id: claim.listingId })
  return listing?.ownerUserId
    ? fail(409, 'already_owned', { contactPath: deps.contactPath })
    : fail(409, 'changed')
}

export interface ClaimTarget {
  /** The product's registrable domain: claim addresses must be on it. */
  domain: string
  listing: { name: string; slug: string }
  /** The claimer's open claim of it, to resume. */
  openClaim: ClaimView | null
  /** Whether the paid method is offered (#68). */
  paid: boolean
  /** The product page the badge goes on. */
  productUrl: string
}

/**
 * What the claim dialog needs before its first step (#70 screen 8): the listing, its product
 * domain, and the claimer's open claim, or why it can't be claimed (`already_owned` with the
 * contact path, a hold or an unresolvable link, a block).
 */
export async function claimTarget(
  deps: ClaimDependencies,
  input: { listingSlug: string; userId: string }
): Promise<ClaimResult<{ target: ClaimTarget }>> {
  const target = await claimableListing(deps, { slug: input.listingSlug })
  if (!target.ok) return target
  const { listing, site } = target
  const open = await deps.operations.openClaim({ listingId: listing.id, userId: input.userId })
  return {
    ok: true,
    target: {
      domain: site.domain,
      listing: { name: listing.name, slug: listing.slug },
      openClaim: open ? view(open, listing) : null,
      paid: deps.paidClaims,
      productUrl: site.url
    }
  }
}

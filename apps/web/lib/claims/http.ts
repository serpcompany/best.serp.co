import 'server-only'

import { apiError, json } from '@/lib/submissions/http'
import type { ClaimFailure, ClaimFailureCode } from './service'

/**
 * The claim API's error answers (#67). The claim dialog (#70 screen 8) never shows these
 * strings: it maps each `code` to its approved copy.
 */
const MESSAGES: Record<ClaimFailureCode, string> = {
  already_owned: 'This listing already has an owner.',
  checks_used: 'No badge checks left for this claim.',
  blocked: 'This URL can’t be claimed.',
  changed: 'This claim changed. Reload and try again.',
  code_expired: 'This code expired. Ask for a new one.',
  confirmation_expired: 'Confirm your email again.',
  cooldown: 'Try again in a moment.',
  domain_mismatch: 'Use an address on the listing’s domain.',
  invalid_code: 'That code isn’t right.',
  invalid_email: 'Enter a valid email address.',
  invalid_method: 'Choose how to claim this listing.',
  no_product_domain: 'This URL can’t be claimed.',
  not_owner: 'This claim no longer gives you ownership.',
  review_required: 'This URL can’t be claimed.',
  not_confirmed: 'Confirm your email first.',
  not_found: 'Listing not found.',
  too_many_attempts: 'Too many wrong codes. Try again later.',
  webmail: 'Use an address on the listing’s domain, not a webmail address.'
}

export function claimFailure(failure: ClaimFailure) {
  const extra = {
    ...(failure.attemptsLeft !== undefined ? { attemptsLeft: failure.attemptsLeft } : {}),
    ...(failure.contactPath ? { contactPath: failure.contactPath } : {}),
    ...(failure.retryAfterSeconds ? { retryAfterSeconds: failure.retryAfterSeconds } : {}),
    ...(failure.self ? { self: true } : {})
  }
  const response = apiError(failure.status, failure.code, MESSAGES[failure.code], extra)
  if (failure.retryAfterSeconds) {
    response.headers.set('Retry-After', String(failure.retryAfterSeconds))
  }
  return response
}

/** 404 for every claim endpoint while claims are off. */
export function claimsOff() {
  return apiError(404, 'not_found', 'Not found.')
}

export { json }

import 'server-only'

import { NextResponse } from 'next/server'
import type { Authorization } from '@/lib/auth/guards'
import {
  type ApiError,
  type Availability,
  draftExpiresInDays,
  listingPath,
  nextStepPath,
  type SubmissionField,
  type SubmissionSummary
} from './contract'
import { isSubmissionError, type OwnSubmission, type UrlAvailability } from './repository'

/** Response helpers for the submit flow's route handlers (#63). Every answer is `no-store`. */

const NO_STORE = { 'Cache-Control': 'private, no-store' }

export function json<T>(body: T, status = 200, headers: Record<string, string> = {}) {
  return NextResponse.json(body, { headers: { ...NO_STORE, ...headers }, status })
}

export function apiError(
  status: number,
  code: string,
  error: string,
  extra: Omit<ApiError, 'code' | 'error'> = {}
) {
  return json<ApiError>({ code, error, ...extra }, status)
}

export function authorizationFailure(result: Exclude<Authorization, { ok: true }>) {
  if (result.status === 401) return apiError(401, 'session_required', 'Sign in to continue.')
  if (result.reason === 'origin_rejected') {
    return apiError(403, 'origin_rejected', 'This request must come from best.serp.co.')
  }
  return apiError(503, 'auth_unavailable', 'Accounts are unavailable right now.')
}

/** Reads a JSON body of at most `maxBytes`, or null when it is missing, too large, or invalid. */
export async function readJson(request: Request, maxBytes = 32_000): Promise<unknown | null> {
  const declared = Number(request.headers.get('content-length') || '0')
  if (declared > maxBytes) return null
  const text = await request.text().catch(() => null)
  if (text === null || text.length > maxBytes) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

export function toAvailability(availability: UrlAvailability): Availability {
  if (availability.kind === 'listed') {
    return {
      kind: 'listed',
      listing: { ...availability.listing, path: listingPath(availability.listing.slug) }
    }
  }
  if (availability.kind === 'pending') {
    return {
      kind: 'pending',
      mine: availability.mine
        ? {
            id: availability.mine.id,
            nextPath: nextStepPath(availability.mine),
            status: availability.mine.status
          }
        : null,
      slug: availability.slug
    }
  }
  return availability
}

export function toSummary(submission: OwnSubmission, now = new Date()): SubmissionSummary {
  return {
    badgeVerifiedAt: submission.badgeVerifiedAt,
    categoryName: submission.categoryName,
    categorySlug: submission.categorySlug,
    content: submission.content,
    contentVersion: submission.contentVersion,
    description: submission.description,
    draftExpiresInDays:
      submission.status === 'draft' ? draftExpiresInDays(submission.draftSavedAt, now) : null,
    id: submission.id,
    lastVerificationAt: submission.lastVerificationAt,
    lastVerificationError: submission.lastVerificationError,
    logoUrl: submission.logoUrl,
    name: submission.name,
    plan: submission.plan,
    slug: submission.slug,
    status: submission.status,
    verificationAttempts: submission.verificationAttempts,
    website: submission.website
  }
}

/** The answer for a website that cannot be submitted (the form shows `availability`). */
export function unavailableResponse(availability: Exclude<Availability, { kind: 'available' }>) {
  switch (availability.kind) {
    case 'invalid':
      return apiError(400, 'invalid_url', availability.message, {
        availability,
        fields: { website: availability.message }
      })
    case 'blocked':
      return apiError(403, 'url_blocked', 'This website can’t be submitted.', { availability })
    case 'listed':
      return apiError(409, 'listing_exists', 'This website is already listed.', { availability })
    default:
      return apiError(409, 'duplicate_submission', 'This website is already submitted.', {
        availability
      })
  }
}

const FIELD_BY_CODE: Record<string, SubmissionField> = {
  invalid_category: 'categorySlug',
  invalid_content: 'content',
  invalid_description: 'description',
  invalid_logo: 'logoUrl',
  invalid_name: 'name',
  invalid_url: 'website'
}

/** Maps a thrown error to the API's answer; anything unexpected is a logged 500. */
export function submissionFailure(error: unknown, fallback: string) {
  if (isSubmissionError(error)) {
    const field = FIELD_BY_CODE[error.code]
    return apiError(error.status, error.code, error.message, {
      ...(error.availability ? { availability: toAvailability(error.availability) } : {}),
      ...(field ? { fields: { [field]: error.message } } : {})
    })
  }
  console.error(
    JSON.stringify({
      event: 'submission_request_failed',
      message: error instanceof Error ? error.message : String(error)
    })
  )
  return apiError(500, 'internal_error', fallback)
}

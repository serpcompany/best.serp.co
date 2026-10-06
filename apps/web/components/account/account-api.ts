import type { ExtrasInput, RevisionRequest } from '@/lib/account/contract'
import type { DraftContentInput } from '@/lib/submissions/contract'
import { call } from '../submit/submit-api'

/**
 * Browser calls to the dashboard's API (#65). Same-origin JSON: the browser sends the session
 * cookie and `Origin`, which the handlers require for every write.
 */

const post = <T>(path: string, body: unknown = {}) =>
  call<T>(path, { body: JSON.stringify(body), method: 'POST' })

const submission = (id: string, action: string) =>
  `/api/account/submissions/${encodeURIComponent(id)}/${action}`
const listing = (id: string, action: string) =>
  `/api/account/listings/${encodeURIComponent(id)}/${action}`

export function withdrawSubmission(id: string) {
  return post<{ ok: true }>(submission(id, 'withdraw'))
}

export function resubmitSubmission(
  id: string,
  input: DraftContentInput & { expectedContentVersion: number }
) {
  return post<{ ok: true; status: string }>(submission(id, 'resubmit'), input)
}

export function saveSubmissionExtras(
  id: string,
  input: ExtrasInput & { expectedContentVersion: number }
) {
  return post<{ contentVersion: number; ok: true }>(submission(id, 'extras'), input)
}

export function saveRevision(listingId: string, input: RevisionRequest) {
  return post<{ ok: true; revisionId: string }>(listing(listingId, 'revision'), input)
}

export function discardRevision(listingId: string) {
  return post<{ ok: true }>(listing(listingId, 'discard-revision'))
}

export interface ListingBadgeResult {
  ok: true
  result: { ok: true } | { code: string; href?: string; ok: false; rel?: string[] }
}

export function verifyListingBadge(listingId: string) {
  return post<ListingBadgeResult>(listing(listingId, 'verify-badge'))
}

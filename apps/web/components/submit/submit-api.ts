import type {
  ApiError,
  NewDraftRequest,
  PrefillResponse,
  SubmissionSummary
} from '@/lib/submissions/contract'

/**
 * Browser calls to the submit flow's API (#63). Every call is same-origin JSON; the browser
 * sends the session cookie and `Origin`, which the handlers require for writes.
 */

export type ApiResult<T> = { data: T; ok: true } | { error: ApiError; ok: false; status: number }

const NETWORK_ERROR: ApiError = {
  code: 'network_error',
  error: 'We couldn’t reach best.serp.co. Check your connection and try again.'
}

/** A same-origin JSON call; the account pages (#65) use it too. */
export async function call<T>(path: string, init: RequestInit): Promise<ApiResult<T>> {
  let response: Response
  try {
    response = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) }
    })
  } catch {
    return { error: NETWORK_ERROR, ok: false, status: 0 }
  }
  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  if (response.ok) return { data: body as T, ok: true }
  const error =
    body && typeof body === 'object' && 'code' in body
      ? (body as ApiError)
      : { code: 'internal_error', error: 'Something went wrong. Try again.' }
  return { error, ok: false, status: response.status }
}

export function requestPrefill(url: string, signal?: AbortSignal) {
  return call<PrefillResponse>('/api/submissions/prefill', {
    body: JSON.stringify({ url }),
    method: 'POST',
    signal
  })
}

export interface SavedSubmission {
  next: string
  submission: SubmissionSummary
}

export function createDraft(input: NewDraftRequest) {
  return call<SavedSubmission>('/api/submissions', {
    body: JSON.stringify(input),
    method: 'POST'
  })
}

export function updateDraft(
  id: string,
  input: Omit<NewDraftRequest, 'website'> & { expectedContentVersion: number }
) {
  return call<SavedSubmission>(`/api/submissions/${encodeURIComponent(id)}`, {
    body: JSON.stringify(input),
    method: 'PATCH'
  })
}

export function chooseFreePlan(id: string) {
  return call<SavedSubmission>(`/api/submissions/${encodeURIComponent(id)}/plan`, {
    body: JSON.stringify({ plan: 'free' }),
    method: 'POST'
  })
}

export interface VerifyResponse {
  result: { ok: true } | { code: string; href?: string; ok: false; rel?: string[]; source?: string }
  submission: SubmissionSummary
}

export function verifyBadge(id: string) {
  return call<VerifyResponse>(`/api/submissions/${encodeURIComponent(id)}/verify`, {
    body: '{}',
    method: 'POST'
  })
}

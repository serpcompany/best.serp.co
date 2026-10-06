/**
 * The admin screens' calls to `/api/admin/*` (#64). Same-origin `fetch` sends the session
 * cookie and the `Origin` header the route handlers require for every write.
 */
export type AdminApiResult<T = Record<string, unknown>> =
  | ({ ok: true; replayed?: boolean } & T)
  | { error: string; message: string; ok: false }

export async function adminRequest<T = Record<string, unknown>>(
  path: string,
  body: unknown,
  method: 'DELETE' | 'POST' = 'POST'
): Promise<AdminApiResult<T>> {
  try {
    const response = await fetch(path, {
      body: JSON.stringify(body ?? {}),
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      method
    })
    const data = (await response.json().catch(() => null)) as Record<string, unknown> | null
    if (data && typeof data === 'object' && 'ok' in data) return data as AdminApiResult<T>
    // The admin gate's own answers (401, 403, 503) carry an error and a message.
    if (data && typeof data === 'object' && 'error' in data && 'message' in data) {
      return { error: String(data.error), message: String(data.message), ok: false }
    }
    return {
      error: 'unexpected_response',
      message: response.ok
        ? 'Unexpected answer from the server.'
        : `Request failed (${response.status}).`,
      ok: false
    }
  } catch {
    return { error: 'network', message: 'Could not reach the server. Try again.', ok: false }
  }
}

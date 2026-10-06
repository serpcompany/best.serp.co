import type { MediaBucket } from './media-ingest'

/** A minimal PNG header of the given size: enough for `sniffImage`, not a decodable image. */
export function pngBytes(width: number, height: number, padding = 0): Uint8Array {
  const bytes = new Uint8Array(33 + padding)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
  bytes.set(
    [...'IHDR'].map(character => character.charCodeAt(0)),
    12
  )
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  bytes.set([8, 6, 0, 0, 0], 24)
  return bytes
}

export interface StoredObject {
  body: Uint8Array
  options: Parameters<MediaBucket['put']>[2]
}

/** An in-memory bucket that records every write. */
export function memoryBucket(): MediaBucket & { objects: Map<string, StoredObject> } {
  const objects = new Map<string, StoredObject>()
  return {
    objects,
    async put(key, value, options) {
      objects.set(key, { body: value, options })
      return {}
    }
  }
}

type Route = Response | (() => Response)

/**
 * A `fetch` that answers from a URL → response table; anything else is unreachable. A
 * `Response` answers once (a clone's body could not be cancelled); a function answers each call.
 */
export function routedFetch(routes: Record<string, Route>): typeof fetch & { calls: string[] } {
  const calls: string[] = []
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input)
    calls.push(url)
    const route = routes[url]
    if (!route) throw new TypeError('fetch failed')
    return typeof route === 'function' ? route() : route
  }) as typeof fetch & { calls: string[] }
  fetcher.calls = calls
  return fetcher
}

export function imageResponse(body: Uint8Array, contentType = 'image/png'): Response {
  return new Response(new Uint8Array(body), { headers: { 'Content-Type': contentType } })
}

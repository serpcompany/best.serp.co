import type { MediaBucket } from './media-ingest'

const text = (value: string) => [...value].map(character => character.charCodeAt(0))
const u16be = (value: number) => [(value >> 8) & 0xff, value & 0xff]
const u16le = (value: number) => [value & 0xff, (value >> 8) & 0xff]
const u24le = (value: number) => [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff]
const u32be = (value: number) => [
  (value >>> 24) & 0xff,
  (value >> 16) & 0xff,
  (value >> 8) & 0xff,
  value & 0xff
]
const u32le = (value: number) => u32be(value).reverse()
const concat = (...parts: number[][]) => Uint8Array.from(parts.flat())

function pngChunk(type: string, data: number[]): number[] {
  // CRCs are not checked by the sniffer; browsers decode the real images we host.
  return [...u32be(data.length), ...text(type), ...data, 0, 0, 0, 0]
}

/**
 * Complete but tiny image files for tests (no image binary is checked in): enough structure for
 * `sniffImage`, not decodable pictures. `padding` grows the PNG's image data.
 */
export function pngBytes(width: number, height: number, padding = 0): Uint8Array {
  return concat(
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    pngChunk('IHDR', [...u32be(width), ...u32be(height), 8, 6, 0, 0, 0]),
    pngChunk('IDAT', new Array(Math.max(1, padding)).fill(0)),
    pngChunk('IEND', [])
  )
}

export function jpegBytes(width: number, height: number): Uint8Array {
  return concat(
    [0xff, 0xd8],
    [0xff, 0xe0],
    u16be(16),
    text('JFIF'),
    [0, 1, 1, 0, 0, 1, 0, 1, 0, 0],
    [0xff, 0xff, 0xc2],
    u16be(17),
    [8],
    u16be(height),
    u16be(width),
    [3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1],
    [0xff, 0xda],
    u16be(12),
    [3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0],
    [0x12, 0x34, 0x56],
    [0xff, 0xd9]
  )
}

export function webpBytes(
  chunk: 'VP8 ' | 'VP8L' | 'VP8X',
  width: number,
  height: number
): Uint8Array {
  const body =
    chunk === 'VP8 '
      ? [0, 0, 0, 0x9d, 0x01, 0x2a, ...u16le(width), ...u16le(height)]
      : chunk === 'VP8L'
        ? [0x2f, ...u32le((width - 1) | ((height - 1) << 14))]
        : [0, 0, 0, 0, ...u24le(width - 1), ...u24le(height - 1)]
  const chunkBytes = [...text(chunk), ...u32le(body.length), ...body]
  return concat(text('RIFF'), u32le(4 + chunkBytes.length), text('WEBP'), chunkBytes)
}

export function gifBytes(width: number, height: number): Uint8Array {
  return concat(
    text('GIF89a'),
    u16le(width),
    u16le(height),
    [0, 0, 0],
    [0x2c, 0, 0, 0, 0, ...u16le(width), ...u16le(height), 0],
    [2, 2, 0x4c, 0x01, 0],
    [0x3b]
  )
}

export function avifBytes(
  width: number,
  height: number,
  brand = 'avif',
  withData = true
): Uint8Array {
  return concat(
    u32be(24),
    text('ftyp'),
    text(brand),
    u32be(0),
    text('mif1'),
    text('miaf'),
    u32be(20),
    text('ispe'),
    u32be(0),
    u32be(width),
    u32be(height),
    withData ? [...u32be(12), ...text('mdat'), 1, 2, 3, 4] : []
  )
}

/** An icon whose entries each hold a small PNG. */
export function icoBytes(...sides: number[]): Uint8Array {
  const images = sides.map(side => [...pngBytes(side, side, 40)])
  let offset = 6 + sides.length * 16
  const entries = sides.map((side, index) => {
    const size = images[index]?.length ?? 0
    const entry = [side % 256, side % 256, 0, 0, 1, 0, 32, 0, ...u32le(size), ...u32le(offset)]
    offset += size
    return entry
  })
  return concat([0, 0, 1, 0], u16le(sides.length), ...entries, ...images)
}

export interface StoredObject {
  body: Uint8Array
  options: Parameters<MediaBucket['put']>[2]
}

/** An in-memory bucket that records every write. */
export function memoryBucket(): MediaBucket & { objects: Map<string, StoredObject> } {
  const objects = new Map<string, StoredObject>()
  return {
    async delete(key) {
      objects.delete(key)
    },
    async get(key) {
      const object = objects.get(key)
      return object ? { arrayBuffer: async () => object.body.slice().buffer as ArrayBuffer } : null
    },
    objects,
    async put(key, value, options) {
      objects.set(key, { body: value, options })
      return {}
    }
  }
}

type Route = Response | (() => Response | Promise<Response>)

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

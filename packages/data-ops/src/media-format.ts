/**
 * Recognizes a listing image by its bytes, never by a declared type or file name
 * (serpcompany/best.serp.co#95): PNG, JPEG, WebP, GIF, AVIF, and ICO are hosted; SVG is
 * recognized only to be refused, because a same-host SVG can carry script. Dimensions come from
 * the format's own header, so no image is decoded.
 */

export const HOSTED_IMAGE_FORMATS = ['png', 'jpeg', 'webp', 'gif', 'avif', 'ico'] as const
export type HostedImageFormat = (typeof HOSTED_IMAGE_FORMATS)[number]

export const IMAGE_CONTENT_TYPES: Readonly<Record<HostedImageFormat, string>> = {
  avif: 'image/avif',
  gif: 'image/gif',
  ico: 'image/x-icon',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp'
}

export const IMAGE_EXTENSIONS: Readonly<Record<HostedImageFormat, string>> = {
  avif: 'avif',
  gif: 'gif',
  ico: 'ico',
  jpeg: 'jpg',
  png: 'png',
  webp: 'webp'
}

/** The largest side a header may declare; anything larger is a corrupt or hostile header. */
export const MAX_IMAGE_SIDE = 65_535

export type ImageSniff =
  | { format: HostedImageFormat; height: number; ok: true; width: number }
  | { ok: false; reason: 'svg' | 'unknown_format' | 'unreadable_dimensions' }

function ascii(bytes: Uint8Array, start: number, length: number): string {
  let text = ''
  for (let index = start; index < start + length && index < bytes.length; index += 1) {
    text += String.fromCharCode(bytes[index] ?? 0)
  }
  return text
}

function u16be(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0)
}

function u16le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8)
}

function u24le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16)
}

function u32be(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset] ?? 0) << 24) >>> 0) +
    ((bytes[offset + 1] ?? 0) << 16) +
    ((bytes[offset + 2] ?? 0) << 8) +
    (bytes[offset + 3] ?? 0)
  )
}

function u32le(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0
  )
}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  return signature.every((value, index) => bytes[offset + index] === value)
}

function sized(format: HostedImageFormat, width: number | null, height: number | null): ImageSniff {
  if (
    width === null ||
    height === null ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > MAX_IMAGE_SIDE ||
    height > MAX_IMAGE_SIDE
  ) {
    return { ok: false, reason: 'unreadable_dimensions' }
  }
  return { format, height, ok: true, width }
}

function pngSize(bytes: Uint8Array): [number, number] | null {
  if (bytes.length < 24 || ascii(bytes, 12, 4) !== 'IHDR') return null
  return [u32be(bytes, 16), u32be(bytes, 20)]
}

/** The first start-of-frame segment carries the frame size; other segments are skipped. */
function jpegSize(bytes: Uint8Array): [number, number] | null {
  let offset = 2
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) return null
    let marker = bytes[offset + 1] ?? 0
    while (marker === 0xff && offset + 2 < bytes.length) {
      offset += 1
      marker = bytes[offset + 1] ?? 0
    }
    offset += 2
    // Markers without a length: TEM, RST0-7, SOI.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue
    if (marker === 0xd9 || marker === 0xda) return null
    const length = u16be(bytes, offset)
    if (length < 2) return null
    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isStartOfFrame) {
      if (offset + 7 > bytes.length) return null
      return [u16be(bytes, offset + 5), u16be(bytes, offset + 3)]
    }
    offset += length
  }
  return null
}

function webpSize(bytes: Uint8Array): [number, number] | null {
  const chunk = ascii(bytes, 12, 4)
  if (chunk === 'VP8 ') {
    if (!startsWith(bytes, [0x9d, 0x01, 0x2a], 23)) return null
    return [u16le(bytes, 26) & 0x3fff, u16le(bytes, 28) & 0x3fff]
  }
  if (chunk === 'VP8L') {
    if (bytes[20] !== 0x2f) return null
    const bits = u32le(bytes, 21)
    return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1]
  }
  if (chunk === 'VP8X') {
    if (bytes.length < 30) return null
    return [u24le(bytes, 24) + 1, u24le(bytes, 27) + 1]
  }
  return null
}

/** AVIF is an ISO-BMFF file with an `avif` or `avis` brand; its size is the largest `ispe` box. */
function isAvif(bytes: Uint8Array): boolean {
  if (ascii(bytes, 4, 4) !== 'ftyp') return false
  const boxSize = Math.min(u32be(bytes, 0), bytes.length, 256)
  for (let offset = 8; offset + 4 <= boxSize; offset += 4) {
    if (offset === 12) continue // minor version
    const brand = ascii(bytes, offset, 4)
    if (brand === 'avif' || brand === 'avis') return true
  }
  return false
}

function avifSize(bytes: Uint8Array): [number, number] | null {
  let best: [number, number] | null = null
  const limit = Math.min(bytes.length, 64 * 1024)
  for (let offset = 4; offset + 16 <= limit; offset += 1) {
    if (ascii(bytes, offset, 4) !== 'ispe') continue
    const width = u32be(bytes, offset + 8)
    const height = u32be(bytes, offset + 12)
    if (!best || width * height > best[0] * best[1]) best = [width, height]
  }
  return best
}

/** The largest entry of the icon directory; a side of 0 means 256. */
function icoSize(bytes: Uint8Array): [number, number] | null {
  const count = u16le(bytes, 4)
  if (count < 1 || count > 256 || bytes.length < 6 + count * 16) return null
  let best: [number, number] | null = null
  for (let index = 0; index < count; index += 1) {
    const entry = 6 + index * 16
    // The reserved byte is always zero; anything else is not an icon directory.
    if (bytes[entry + 3] !== 0) return null
    const width = (bytes[entry] ?? 0) || 256
    const height = (bytes[entry + 1] ?? 0) || 256
    if (!best || width * height > best[0] * best[1]) best = [width, height]
  }
  return best
}

/** Text that opens like an SVG document, after an optional byte-order mark and whitespace. */
function looksLikeSvg(bytes: Uint8Array): boolean {
  const head = ascii(bytes, 0, 512).replace(/^ï»¿/u, '').trimStart().toLowerCase()
  return (
    head.startsWith('<svg') ||
    head.startsWith('<!doctype svg') ||
    ((head.startsWith('<?xml') || head.startsWith('<!--')) && head.includes('<svg'))
  )
}

export function sniffImage(bytes: Uint8Array): ImageSniff {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    const size = pngSize(bytes)
    return sized('png', size?.[0] ?? null, size?.[1] ?? null)
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    const size = jpegSize(bytes)
    return sized('jpeg', size?.[0] ?? null, size?.[1] ?? null)
  }
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    const size = webpSize(bytes)
    return sized('webp', size?.[0] ?? null, size?.[1] ?? null)
  }
  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') {
    return sized('gif', u16le(bytes, 6), u16le(bytes, 8))
  }
  if (isAvif(bytes)) {
    const size = avifSize(bytes)
    return sized('avif', size?.[0] ?? null, size?.[1] ?? null)
  }
  if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00])) {
    const size = icoSize(bytes)
    return sized('ico', size?.[0] ?? null, size?.[1] ?? null)
  }
  if (looksLikeSvg(bytes)) return { ok: false, reason: 'svg' }
  return { ok: false, reason: 'unknown_format' }
}

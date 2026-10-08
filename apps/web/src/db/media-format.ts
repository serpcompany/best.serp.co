/**
 * Recognizes a listing image by its bytes, never by a declared type or file name
 * (serpcompany/best.serp.co#95): PNG, JPEG, WebP, GIF, AVIF, and ICO are hosted; SVG is
 * recognized only to be refused, because a same-host SVG can carry script. Dimensions come from
 * the format's own header, and the file's structure is checked to the end (PNG chunks through
 * IEND, a JPEG scan and EOI, a GIF image and trailer, a WebP RIFF size, AVIF image data, each ICO
 * entry inside the file), so a header-only stub or a header glued to other bytes is refused. The
 * pixel count is capped, so no declared size can blow up a renderer. No image is decoded.
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

/** The largest side a hosted image may have. */
export const MAX_IMAGE_SIDE = 16_384
/** The most pixels a hosted image may have (width × height), about a 7,700 × 5,200 screenshot. */
export const MAX_IMAGE_PIXELS = 40_000_000

export type ImageSniffFailure =
  | 'corrupt_image'
  | 'svg'
  | 'too_many_pixels'
  | 'unknown_format'
  | 'unreadable_dimensions'

export type ImageSniff =
  | { format: HostedImageFormat; height: number; ok: true; width: number }
  | { ok: false; reason: ImageSniffFailure }

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

function sized(
  format: HostedImageFormat,
  width: number | null,
  height: number | null,
  complete: boolean
): ImageSniff {
  if (
    width === null ||
    height === null ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1
  ) {
    return { ok: false, reason: 'unreadable_dimensions' }
  }
  if (width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE || width * height > MAX_IMAGE_PIXELS) {
    return { ok: false, reason: 'too_many_pixels' }
  }
  if (!complete) return { ok: false, reason: 'corrupt_image' }
  return { format, height, ok: true, width }
}

function indexOfBytes(bytes: Uint8Array, pattern: readonly number[], from = 0): number {
  outer: for (let index = from; index + pattern.length <= bytes.length; index += 1) {
    for (let offset = 0; offset < pattern.length; offset += 1) {
      if (bytes[index + offset] !== pattern[offset]) continue outer
    }
    return index
  }
  return -1
}

/** Every chunk fits the file, the first is IHDR, image data follows, and IEND ends it. */
function pngComplete(bytes: Uint8Array): boolean {
  let offset = 8
  let first = true
  let imageData = false
  while (offset + 12 <= bytes.length) {
    const length = u32be(bytes, offset)
    const type = ascii(bytes, offset + 4, 4)
    if (first && type !== 'IHDR') return false
    first = false
    const next = offset + 12 + length
    if (next > bytes.length) return false
    if (type === 'IDAT' && length > 0) imageData = true
    if (type === 'IEND') return imageData
    offset = next
  }
  return false
}

/** A start of scan follows the frame header, and an end-of-image marker follows the scan. */
function jpegComplete(bytes: Uint8Array): boolean {
  const scan = indexOfBytes(bytes, [0xff, 0xda], 2)
  return scan > 0 && indexOfBytes(bytes, [0xff, 0xd9], scan + 2) > scan
}

/** An image descriptor after the header, and the trailer near the end. */
function gifComplete(bytes: Uint8Array): boolean {
  const descriptor = indexOfBytes(bytes, [0x2c], 13)
  const tail = bytes.subarray(Math.max(descriptor + 10, bytes.length - 32))
  return descriptor > 0 && tail.includes(0x3b)
}

/** The RIFF size covers the file, and the first chunk's data fits inside it. */
function webpComplete(bytes: Uint8Array): boolean {
  const riffEnd = u32le(bytes, 4) + 8
  const chunkEnd = 20 + u32le(bytes, 16)
  return riffEnd >= 20 && riffEnd <= bytes.length + 1 && chunkEnd <= riffEnd + 1
}

/** Image data (`mdat`) follows the metadata. */
function avifComplete(bytes: Uint8Array): boolean {
  const mdat = indexOfBytes(bytes, [0x6d, 0x64, 0x61, 0x74])
  return mdat > 0 && u32be(bytes, mdat - 4) > 8
}

/** Every entry's image lies inside the file and starts as a PNG or a bitmap header. */
function icoComplete(bytes: Uint8Array): boolean {
  const count = u16le(bytes, 4)
  const directoryEnd = 6 + count * 16
  for (let index = 0; index < count; index += 1) {
    const entry = 6 + index * 16
    const size = u32le(bytes, entry + 8)
    const offset = u32le(bytes, entry + 12)
    if (size < 40 || offset < directoryEnd || offset + size > bytes.length) return false
    const png = startsWith(bytes, [0x89, 0x50, 0x4e, 0x47], offset)
    if (!png && u32le(bytes, offset) !== 40) return false
  }
  return count > 0
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
    return sized('png', size?.[0] ?? null, size?.[1] ?? null, pngComplete(bytes))
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    const size = jpegSize(bytes)
    return sized('jpeg', size?.[0] ?? null, size?.[1] ?? null, jpegComplete(bytes))
  }
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    const size = webpSize(bytes)
    return sized('webp', size?.[0] ?? null, size?.[1] ?? null, webpComplete(bytes))
  }
  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') {
    const size = bytes.length >= 10 ? ([u16le(bytes, 6), u16le(bytes, 8)] as const) : null
    return sized('gif', size?.[0] ?? null, size?.[1] ?? null, gifComplete(bytes))
  }
  if (isAvif(bytes)) {
    const size = avifSize(bytes)
    return sized('avif', size?.[0] ?? null, size?.[1] ?? null, avifComplete(bytes))
  }
  if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00])) {
    const size = icoSize(bytes)
    return sized('ico', size?.[0] ?? null, size?.[1] ?? null, icoComplete(bytes))
  }
  if (looksLikeSvg(bytes)) return { ok: false, reason: 'svg' }
  return { ok: false, reason: 'unknown_format' }
}

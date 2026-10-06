import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sniffImage } from './media-format'

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
const bytes = (...parts: number[][]) => Uint8Array.from(parts.flat())

function png(width: number, height: number): Uint8Array {
  return bytes(
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    u32be(13),
    text('IHDR'),
    u32be(width),
    u32be(height),
    [8, 6, 0, 0, 0]
  )
}

function jpeg(width: number, height: number): Uint8Array {
  return bytes(
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
    [3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]
  )
}

function webp(chunk: 'VP8 ' | 'VP8L' | 'VP8X', width: number, height: number): Uint8Array {
  const body =
    chunk === 'VP8 '
      ? bytes([0, 0, 0], [0x9d, 0x01, 0x2a], u16le(width), u16le(height))
      : chunk === 'VP8L'
        ? bytes([0x2f], u32le((width - 1) | ((height - 1) << 14)))
        : bytes([0, 0, 0, 0], u24le(width - 1), u24le(height - 1))
  return bytes(text('RIFF'), u32be(0), text('WEBP'), text(chunk), u32be(body.length), [...body])
}

function avif(width: number, height: number, brand = 'avif'): Uint8Array {
  return bytes(
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
    u32be(height)
  )
}

function ico(...sides: number[]): Uint8Array {
  return bytes(
    [0, 0, 1, 0],
    u16le(sides.length),
    ...sides.map(side => [side % 256, side % 256, 0, 0, 1, 0, 32, 0, 0, 0, 0, 0, 0, 0, 0, 0])
  )
}

describe('sniffImage', () => {
  it.each([
    ['png', png(640, 480), 640, 480],
    ['jpeg', jpeg(1200, 630), 1200, 630],
    ['webp', webp('VP8 ', 300, 200), 300, 200],
    ['webp', webp('VP8L', 128, 64), 128, 64],
    ['webp', webp('VP8X', 4000, 3000), 4000, 3000],
    ['gif', bytes(text('GIF89a'), u16le(48), u16le(32)), 48, 32],
    ['avif', avif(1920, 1080), 1920, 1080],
    ['avif', avif(512, 512, 'avis'), 512, 512],
    ['ico', ico(16, 32, 256), 256, 256]
  ])('reads a %s header and its size', (format, image, width, height) => {
    expect(sniffImage(image)).toEqual({ format, height, ok: true, width })
  })

  it('reads the checked-in fallback tile as a 512px PNG', () => {
    const tile = readFileSync(
      resolve(__dirname, '../../../apps/web/public/listing-logos/favicon-fallback-512x512.png')
    )
    expect(sniffImage(tile)).toEqual({ format: 'png', height: 512, ok: true, width: 512 })
  })

  it.each([
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    '﻿  <?xml version="1.0"?>\n<svg viewBox="0 0 1 1"/>',
    '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN"><svg/>',
    '<!-- logo --><svg/>'
  ])('refuses SVG: %s', source => {
    expect(sniffImage(new TextEncoder().encode(source))).toEqual({ ok: false, reason: 'svg' })
  })

  it('names the format by bytes, never by what a server or file name claims', () => {
    expect(sniffImage(new TextEncoder().encode('<!doctype html><title>404</title>'))).toEqual({
      ok: false,
      reason: 'unknown_format'
    })
    expect(sniffImage(new Uint8Array())).toEqual({ ok: false, reason: 'unknown_format' })
  })

  it('refuses a recognized header without a usable size', () => {
    expect(sniffImage(png(0, 10))).toEqual({ ok: false, reason: 'unreadable_dimensions' })
    expect(sniffImage(png(70_000, 10))).toEqual({ ok: false, reason: 'unreadable_dimensions' })
    expect(sniffImage(png(10, 10).subarray(0, 20))).toEqual({
      ok: false,
      reason: 'unreadable_dimensions'
    })
    expect(sniffImage(bytes([0xff, 0xd8, 0xff, 0xd9]))).toEqual({
      ok: false,
      reason: 'unreadable_dimensions'
    })
    expect(sniffImage(avif(0, 0))).toEqual({ ok: false, reason: 'unreadable_dimensions' })
  })

  it('does not take any 00 00 01 00 prefix for an icon', () => {
    const notIcon = ico(32)
    notIcon[9] = 7
    expect(sniffImage(notIcon)).toEqual({ ok: false, reason: 'unreadable_dimensions' })
  })
})

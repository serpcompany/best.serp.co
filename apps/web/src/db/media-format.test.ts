import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MAX_IMAGE_PIXELS, sniffImage } from './media-format'
import { avifBytes, gifBytes, icoBytes, jpegBytes, pngBytes, webpBytes } from './media-test-support'

describe('sniffImage', () => {
  it.each([
    ['png', pngBytes(640, 480), 640, 480],
    ['jpeg', jpegBytes(1200, 630), 1200, 630],
    ['webp', webpBytes('VP8 ', 300, 200), 300, 200],
    ['webp', webpBytes('VP8L', 128, 64), 128, 64],
    ['webp', webpBytes('VP8X', 4000, 3000), 4000, 3000],
    ['gif', gifBytes(48, 32), 48, 32],
    ['avif', avifBytes(1920, 1080), 1920, 1080],
    ['avif', avifBytes(512, 512, 'avis'), 512, 512],
    ['ico', icoBytes(16, 32, 256), 256, 256]
  ])('reads a complete %s file and its size', (format, image, width, height) => {
    expect(sniffImage(image)).toEqual({ format, height, ok: true, width })
  })

  it('reads the checked-in fallback tile as a 512px PNG', () => {
    const tile = readFileSync(
      resolve(__dirname, '../../public/listing-logos/favicon-fallback-512x512.png')
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

  it('refuses header-only stubs and headers glued to other bytes', () => {
    const corrupt = { ok: false, reason: 'corrupt_image' }
    // A PNG signature and IHDR with no image data or IEND.
    expect(sniffImage(pngBytes(10, 10).subarray(0, 33))).toEqual(corrupt)
    // A 10-byte GIF header.
    expect(sniffImage(gifBytes(16, 16).subarray(0, 10))).toEqual(corrupt)
    // A JPEG frame header without a scan or end of image.
    const jpeg = jpegBytes(32, 32)
    expect(sniffImage(jpeg.subarray(0, jpeg.indexOf(0xda) - 1))).toEqual(corrupt)
    // An icon directory followed by HTML instead of its image.
    const ico = icoBytes(16)
    const html = new TextEncoder().encode('<html>'.repeat(20))
    expect(sniffImage(Uint8Array.from([...ico.subarray(0, 22), ...html]))).toEqual(corrupt)
    // A WebP whose RIFF size claims more than the file holds.
    const webp = webpBytes('VP8 ', 30, 20)
    webp.set([0xe8, 0x03, 0, 0], 4)
    expect(sniffImage(webp)).toEqual(corrupt)
    expect(sniffImage(avifBytes(64, 64, 'avif', false))).toEqual(corrupt)
  })

  it('caps the pixel count, whatever the header declares', () => {
    expect(sniffImage(pngBytes(65_535, 65_535))).toEqual({ ok: false, reason: 'too_many_pixels' })
    expect(sniffImage(pngBytes(20_000, 10))).toEqual({ ok: false, reason: 'too_many_pixels' })
    const side = Math.floor(Math.sqrt(MAX_IMAGE_PIXELS))
    expect(sniffImage(pngBytes(side, side))).toMatchObject({ ok: true })
    expect(sniffImage(pngBytes(side + 1, side + 1))).toEqual({
      ok: false,
      reason: 'too_many_pixels'
    })
  })

  it('refuses a recognized header without a usable size', () => {
    expect(sniffImage(pngBytes(0, 10))).toEqual({ ok: false, reason: 'unreadable_dimensions' })
    expect(sniffImage(Uint8Array.of(0xff, 0xd8, 0xff, 0xd9))).toEqual({
      ok: false,
      reason: 'unreadable_dimensions'
    })
    expect(sniffImage(avifBytes(0, 0))).toEqual({ ok: false, reason: 'unreadable_dimensions' })
  })

  it('does not take any 00 00 01 00 prefix for an icon', () => {
    const notIcon = icoBytes(32)
    notIcon[9] = 7
    expect(sniffImage(notIcon)).toEqual({ ok: false, reason: 'unreadable_dimensions' })
  })
})

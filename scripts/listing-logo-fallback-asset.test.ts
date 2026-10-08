import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SITE_LISTING_LOGO_FALLBACK_PATH } from '../apps/web/src/lib/directory/listing-logo-presentation'
import { project } from './project'

const PNG_SIGNATURE = '89504e470d0a1a0a'
const COLOR_TYPE_PALETTE = 3
const COLOR_TYPE_RGBA = 6
const fallbackAssetPath = resolve(
  project.appDirectory,
  'public',
  DEFAULT_SITE_LISTING_LOGO_FALLBACK_PATH.replace(/^\//u, '')
)
const fallbackSourcePath = resolve('scripts/assets/listing-logo-fallback.svg')

interface PngSummary {
  bitDepth: number
  colorType: number
  height: number
  topLeftAlpha: number
  width: number
}

/**
 * Reads the IHDR and the alpha of the top-left pixel. That pixel needs no filter predictor
 * (it has no left, upper, or upper-left neighbour), so its raw byte is its value.
 */
function summarizePng(png: Buffer): PngSummary {
  expect(png.subarray(0, 8).toString('hex')).toBe(PNG_SIGNATURE)

  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let transparency: Buffer | undefined
  const idatChunks: Buffer[] = []

  while (offset < png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.toString('ascii', offset + 4, offset + 8)
    const data = png.subarray(offset + 8, offset + 8 + length)

    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8] ?? 0
      colorType = data[9] ?? 0
    }
    if (type === 'tRNS') transparency = data
    if (type === 'IDAT') idatChunks.push(data)

    offset += 12 + length
  }

  const pixels = inflateSync(Buffer.concat(idatChunks))
  let topLeftAlpha = 255

  if (colorType === COLOR_TYPE_PALETTE) {
    const paletteIndex = pixels[1] ?? 0
    topLeftAlpha = transparency?.[paletteIndex] ?? 255
  } else if (colorType === COLOR_TYPE_RGBA) {
    topLeftAlpha = pixels[4] ?? 255
  }

  return { bitDepth, colorType, height, topLeftAlpha, width }
}

describe('listing logo fallback asset', () => {
  it('is served from apps/web/public at the path the UI requests', () => {
    expect(DEFAULT_SITE_LISTING_LOGO_FALLBACK_PATH).toBe(
      '/listing-logos/favicon-fallback-512x512.png'
    )
    expect(existsSync(fallbackAssetPath)).toBe(true)
  })

  it('is a small 512x512 PNG with transparent corners, so it sits on light and dark surfaces', () => {
    const summary = summarizePng(readFileSync(fallbackAssetPath))

    expect(summary.width).toBe(512)
    expect(summary.height).toBe(512)
    expect(summary.bitDepth).toBe(8)
    expect([COLOR_TYPE_PALETTE, COLOR_TYPE_RGBA]).toContain(summary.colorType)
    expect(summary.topLeftAlpha).toBe(0)
    expect(statSync(fallbackAssetPath).size).toBeLessThan(32 * 1024)
  })

  it('keeps its SVG source next to the render instructions', () => {
    const source = readFileSync(fallbackSourcePath, 'utf8')

    expect(source).toContain('viewBox="0 0 512 512"')
    expect(source).toContain('favicon-fallback-512x512.png')
    expect(source).not.toMatch(/<text\b|font-family/u)
  })
})

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { inflateSync } from 'node:zlib'
import { site } from '@serpdirectory/site-config'
import { describe, expect, it } from 'vitest'
import { project } from './project'

const badgeVariants = ['light', 'dark'] as const
const PNG_SIGNATURE = '89504e470d0a1a0a'
const BADGE_TEXT_X = 42
const BADGE_RIGHT_MARGIN = 10
const BADGE_WIDTH = 200
const BADGE_HEIGHT = 50
const BADGE_TEXT_MAX_WIDTH = BADGE_WIDTH - BADGE_TEXT_X - BADGE_RIGHT_MARGIN
const BADGE_ICON_X = 12
const BADGE_ICON_Y = 15
const BADGE_ICON_SIZE = 20
const BADGE_LABEL_FONT_SIZE = 8
const BADGE_NAME_MAX_FONT_SIZE = 13

function getBadgeKey(variant: (typeof badgeVariants)[number]): string {
  const configuredKey = site.badges?.featuredOn?.[variant]

  if (!configuredKey) {
    throw new Error(`${site.id}: missing ${variant} featuredOn badge config`)
  }

  return configuredKey
}

function getBadgeAssetPath(variant: (typeof badgeVariants)[number]): string {
  return resolve(project.appDirectory, 'public', getBadgeKey(variant))
}

function getBadgeAssetPaths(): string[] {
  return badgeVariants.map(getBadgeAssetPath)
}

function getPngImageDataUris(svg: string): string[] {
  return Array.from(
    svg.matchAll(/<image\b[^>]*\bhref="data:image\/png;base64,([^"]+)"/g),
    match => match[1]
  )
}

function isSolidOpaqueSquarePng(base64Png: string): boolean {
  const png = Buffer.from(base64Png, 'base64')
  if (png.subarray(0, 8).toString('hex') !== PNG_SIGNATURE) {
    return false
  }

  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  const idatChunks: Buffer[] = []

  while (offset < png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.toString('ascii', offset + 4, offset + 8)
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    const data = png.subarray(dataStart, dataEnd)

    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
    }

    if (type === 'IDAT') {
      idatChunks.push(data)
    }

    offset = dataEnd + 4
  }

  if (width === 0 || width !== height || bitDepth !== 8 || colorType !== 6) {
    return false
  }

  const bytesPerPixel = 4
  const rowStride = width * bytesPerPixel
  const inflated = inflateSync(Buffer.concat(idatChunks))
  const rows = Buffer.alloc(rowStride * height)

  function paethPredictor(left: number, above: number, upperLeft: number): number {
    const estimate = left + above - upperLeft
    const leftDistance = Math.abs(estimate - left)
    const aboveDistance = Math.abs(estimate - above)
    const upperLeftDistance = Math.abs(estimate - upperLeft)

    if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) {
      return left
    }

    return aboveDistance <= upperLeftDistance ? above : upperLeft
  }

  for (let row = 0; row < height; row += 1) {
    const filter = inflated[row * (rowStride + 1)]
    const sourceStart = row * (rowStride + 1) + 1
    const targetStart = row * rowStride

    for (let column = 0; column < rowStride; column += 1) {
      const raw = inflated[sourceStart + column]
      const left = column >= bytesPerPixel ? rows[targetStart + column - bytesPerPixel] : 0
      const above = row > 0 ? rows[targetStart + column - rowStride] : 0
      const upperLeft =
        row > 0 && column >= bytesPerPixel
          ? rows[targetStart + column - rowStride - bytesPerPixel]
          : 0

      if (filter === 0) {
        rows[targetStart + column] = raw
      } else if (filter === 1) {
        rows[targetStart + column] = (raw + left) & 0xff
      } else if (filter === 2) {
        rows[targetStart + column] = (raw + above) & 0xff
      } else if (filter === 3) {
        rows[targetStart + column] = (raw + Math.floor((left + above) / 2)) & 0xff
      } else if (filter === 4) {
        rows[targetStart + column] = (raw + paethPredictor(left, above, upperLeft)) & 0xff
      } else {
        return false
      }
    }
  }

  const firstPixel = rows.subarray(0, bytesPerPixel)
  if (firstPixel[3] !== 255) {
    return false
  }

  for (let offset = 0; offset < rows.length; offset += bytesPerPixel) {
    if (
      rows[offset] !== firstPixel[0] ||
      rows[offset + 1] !== firstPixel[1] ||
      rows[offset + 2] !== firstPixel[2] ||
      rows[offset + 3] !== 255
    ) {
      return false
    }
  }

  return true
}

function decodeSvgText(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&gt;', '>')
    .replaceAll('&lt;', '<')
    .replaceAll('&amp;', '&')
}

function estimateTextWidth(value: string, fontSize: number): number {
  const widthUnits = Array.from(value).reduce((total, character) => {
    if (character === ' ') {
      return total + 0.28
    }

    if (character === '.') {
      return total + 0.25
    }

    if (/[A-Z]/.test(character)) {
      return total + 0.62
    }

    if (/[0-9]/.test(character)) {
      return total + 0.54
    }

    return total + 0.52
  }, 0)

  return widthUnits * fontSize
}

describe('featured badge assets', () => {
  it('configures explicit light and dark featured badges for best.serp.co', () => {
    expect(site.id).toBe(project.domain)
    expect(badgeVariants.map(getBadgeKey)).toEqual([
      'badge/featured-on-serp.co-light.svg',
      'badge/featured-on-serp.co-dark.svg'
    ])
  })

  it('has light and dark static badge SVGs in the web app', () => {
    const missingAssets = getBadgeAssetPaths().filter(assetPath => !existsSync(assetPath))

    expect(missingAssets).toEqual([])
  })

  it('renders a real logo mark in every static badge', () => {
    const badgesWithoutLogos = getBadgeAssetPaths().filter(assetPath => {
      if (!existsSync(assetPath)) {
        return false
      }

      const svg = readFileSync(assetPath, 'utf-8')

      return (
        !/<image\b[^>]*\bhref="data:image\/(?:png|svg\+xml);base64,/.test(svg) &&
        !/<(?:svg|g)\b[^>]*\bdata-badge-logo="true"/.test(svg)
      )
    })

    expect(badgesWithoutLogos).toEqual([])
  })

  it('does not embed solid opaque square PNG logos in static badges', () => {
    const badgesWithSolidSquarePngLogos = getBadgeAssetPaths().filter(assetPath => {
      if (!existsSync(assetPath)) {
        return false
      }

      const svg = readFileSync(assetPath, 'utf-8')

      return getPngImageDataUris(svg).some(isSolidOpaqueSquarePng)
    })

    expect(badgesWithSolidSquarePngLogos).toEqual([])
  })

  it('uses the compact fixed-width badge geometry', () => {
    const badgesWithDifferentGeometry = badgeVariants.flatMap(variant => {
      const assetPath = getBadgeAssetPath(variant)

      if (!existsSync(assetPath)) {
        return [`${variant}: missing badge`]
      }

      const svg = readFileSync(assetPath, 'utf-8')
      const expectedRect =
        variant === 'dark'
          ? '<rect x="1" y="1" width="198" height="48" rx="5" fill="#1a1a1a" stroke="#333333" stroke-width="1"/>'
          : '<rect x="1" y="1" width="198" height="48" rx="5" fill="#ffffff" stroke="#e5e7eb" stroke-width="1"/>'

      const problems: string[] = []

      if (!new RegExp(`<svg width="${BADGE_WIDTH}" height="${BADGE_HEIGHT}"`).test(svg)) {
        problems.push(`${variant}: svg`)
      }

      if (!svg.includes(expectedRect)) {
        problems.push(`${variant}: rect`)
      }

      if (
        !new RegExp(
          `(?:<image|<svg)\\b[^>]*(?:x="${BADGE_ICON_X}" y="${BADGE_ICON_Y}" width="${BADGE_ICON_SIZE}" height="${BADGE_ICON_SIZE}"|x="${BADGE_ICON_X}" y="${BADGE_ICON_Y}" height="${BADGE_ICON_SIZE}" width="${BADGE_ICON_SIZE}")`
        ).test(svg)
      ) {
        problems.push(`${variant}: icon`)
      }

      if (
        !new RegExp(
          `<text x="${BADGE_TEXT_X}" y="20"[^>]*font-size="${BADGE_LABEL_FONT_SIZE}"[^>]*font-weight="500"`
        ).test(svg)
      ) {
        problems.push(`${variant}: label`)
      }

      const nameMatch = svg.match(
        new RegExp(`<text x="${BADGE_TEXT_X}" y="36"[^>]*font-size="([^"]+)"[^>]*font-weight="700"`)
      )
      if (!nameMatch) {
        problems.push(`${variant}: name`)
      } else if (Number(nameMatch[1]) > BADGE_NAME_MAX_FONT_SIZE) {
        problems.push(`${variant}: name font`)
      }

      return problems
    })

    expect(badgesWithDifferentGeometry).toEqual([])
  })

  it('does not stretch or clip site names to force-fit the badge', () => {
    const badgesWithForcedTextFit = getBadgeAssetPaths().filter(assetPath => {
      if (!existsSync(assetPath)) {
        return false
      }

      const svg = readFileSync(assetPath, 'utf-8')

      return svg.includes('textLength=') || svg.includes('lengthAdjust=')
    })

    expect(badgesWithForcedTextFit).toEqual([])
  })

  it('renders the full site name within the badge right margin', () => {
    const expectedRenderedName = site.badges?.featuredOn?.displayName ?? site.site.name
    const badgesWithCroppedNames = getBadgeAssetPaths().filter(assetPath => {
      if (!existsSync(assetPath)) {
        return false
      }

      const svg = readFileSync(assetPath, 'utf-8')
      const nameTextMatch = svg.match(
        new RegExp(`<text x="${BADGE_TEXT_X}" y="36"[^>]*font-size="([^"]+)"[^>]*>([^<]+)</text>`)
      )

      if (!nameTextMatch) {
        return true
      }

      const fontSize = Number(nameTextMatch[1])
      const renderedName = decodeSvgText(nameTextMatch[2])

      return (
        renderedName !== expectedRenderedName ||
        renderedName.includes('...') ||
        fontSize > BADGE_NAME_MAX_FONT_SIZE ||
        estimateTextWidth(renderedName, fontSize) > BADGE_TEXT_MAX_WIDTH
      )
    })

    expect(badgesWithCroppedNames).toEqual([])
  })
})

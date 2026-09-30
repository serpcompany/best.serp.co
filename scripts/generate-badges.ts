import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync, inflateSync } from 'node:zlib'
import { resolveCheckedInSiteConfig, siteConfigsById } from '@serpdirectory/site-contract'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')
const SERP_ARROW_MARK_PATH = 'apps/serp.software/public/img/serp-arrow-logo-black.svg'
const R2_BADGE_KEY_PREFIX = 'badge'
const BADGE_WIDTH = 200
const BADGE_HEIGHT = 50
const BADGE_TEXT_X = 42
const BADGE_RIGHT_MARGIN = 10
const BADGE_TEXT_MAX_WIDTH = BADGE_WIDTH - BADGE_TEXT_X - BADGE_RIGHT_MARGIN
const BADGE_ICON_X = 12
const BADGE_ICON_Y = 15
const BADGE_ICON_SIZE = 20
const BADGE_LABEL_FONT_SIZE = 8
const BADGE_NAME_MAX_FONT_SIZE = 13
const BADGE_NAME_MIN_FONT_SIZE = 7.5

const SITE_TYPOGRAPHY_OVERRIDES: Record<
  string,
  {
    labelFontSize?: number
    letterSpacing?: string
    nameMaxFontSize?: number
  }
> = {
  'browserextensions.io': {
    labelFontSize: 7,
    nameMaxFontSize: 12
  },
  'pornvideodownloaders.com': {
    labelFontSize: 7,
    letterSpacing: '0',
    nameMaxFontSize: 13
  }
}

type BadgeLogoMark = {
  markup: string
}

type RasterImage = {
  height: number
  rgba: Buffer
  width: number
}

type BadgeLogoSource =
  | {
      kind: 'raster'
      path: string
      raster: RasterImage
    }
  | {
      kind: 'svg'
      path: string
      svg: string
    }

type R2FeaturedBadgeAsset = {
  contentType: 'image/svg+xml'
  height: 50
  key: string
  siteId: string
  source: string
  variant: 'light' | 'dark'
  width: 200
}

const PNG_SIGNATURE = '89504e470d0a1a0a'

function decodePngRgba(png: Buffer): RasterImage | null {
  if (png.subarray(0, 8).toString('hex') !== PNG_SIGNATURE) {
    return null
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

  if (width === 0 || height === 0 || bitDepth !== 8 || colorType !== 6) {
    return null
  }

  const bytesPerPixel = 4
  const rowStride = width * bytesPerPixel
  const inflated = inflateSync(Buffer.concat(idatChunks))
  const rgba = Buffer.alloc(rowStride * height)

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
      const left = column >= bytesPerPixel ? rgba[targetStart + column - bytesPerPixel] : 0
      const above = row > 0 ? rgba[targetStart + column - rowStride] : 0
      const upperLeft =
        row > 0 && column >= bytesPerPixel
          ? rgba[targetStart + column - rowStride - bytesPerPixel]
          : 0

      if (filter === 0) {
        rgba[targetStart + column] = raw
      } else if (filter === 1) {
        rgba[targetStart + column] = (raw + left) & 0xff
      } else if (filter === 2) {
        rgba[targetStart + column] = (raw + above) & 0xff
      } else if (filter === 3) {
        rgba[targetStart + column] = (raw + Math.floor((left + above) / 2)) & 0xff
      } else if (filter === 4) {
        rgba[targetStart + column] = (raw + paethPredictor(left, above, upperLeft)) & 0xff
      } else {
        return null
      }
    }
  }

  return { height, rgba, width }
}

function decodeLargestIcoDib(ico: Buffer): RasterImage | null {
  if (ico.readUInt16LE(0) !== 0 || ico.readUInt16LE(2) !== 1) {
    return null
  }

  const count = ico.readUInt16LE(4)
  const entries = Array.from({ length: count }, (_, index) => {
    const offset = 6 + index * 16
    const width = ico[offset] || 256
    const height = ico[offset + 1] || 256
    const size = ico.readUInt32LE(offset + 8)
    const imageOffset = ico.readUInt32LE(offset + 12)

    return { height, imageOffset, size, width }
  }).sort((a, b) => b.width * b.height - a.width * a.height)

  for (const entry of entries) {
    const dib = ico.subarray(entry.imageOffset, entry.imageOffset + entry.size)
    const headerSize = dib.readUInt32LE(0)
    const width = dib.readInt32LE(4)
    const storedHeight = dib.readInt32LE(8)
    const height = Math.abs(storedHeight) / 2
    const bitDepth = dib.readUInt16LE(14)
    const compression = dib.readUInt32LE(16)

    if (headerSize < 40 || width <= 0 || height <= 0 || bitDepth !== 32 || compression !== 0) {
      continue
    }

    const rgba = Buffer.alloc(width * height * 4)
    const pixelsStart = headerSize

    for (let y = 0; y < height; y += 1) {
      const sourceY = storedHeight > 0 ? height - 1 - y : y
      for (let x = 0; x < width; x += 1) {
        const sourceOffset = pixelsStart + (sourceY * width + x) * 4
        const targetOffset = (y * width + x) * 4

        rgba[targetOffset] = dib[sourceOffset + 2]
        rgba[targetOffset + 1] = dib[sourceOffset + 1]
        rgba[targetOffset + 2] = dib[sourceOffset]
        rgba[targetOffset + 3] = dib[sourceOffset + 3]
      }
    }

    return { height, rgba, width }
  }

  return null
}

function loadRasterImage(assetPath: string): RasterImage | null {
  const absPath = join(REPO_ROOT, assetPath)
  if (!existsSync(absPath)) {
    return null
  }

  const asset = readFileSync(absPath)
  const lowerPath = assetPath.toLowerCase()

  if (lowerPath.endsWith('.png')) {
    return decodePngRgba(asset)
  }

  if (lowerPath.endsWith('.ico')) {
    return decodeLargestIcoDib(asset)
  }

  return null
}

function isSolidOpaqueSquareRaster(image: RasterImage): boolean {
  if (image.width !== image.height || image.rgba.length === 0) {
    return false
  }

  const firstPixel = image.rgba.subarray(0, 4)
  if (firstPixel[3] !== 255) {
    return false
  }

  for (let offset = 0; offset < image.rgba.length; offset += 4) {
    if (
      image.rgba[offset] !== firstPixel[0] ||
      image.rgba[offset + 1] !== firstPixel[1] ||
      image.rgba[offset + 2] !== firstPixel[2] ||
      image.rgba[offset + 3] !== 255
    ) {
      return false
    }
  }

  return true
}

function escapeSvgText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function escapeSvgAttribute(value: string): string {
  return escapeSvgText(value).replaceAll('"', '&quot;')
}

function estimateTextWidthUnits(value: string): number {
  return Array.from(value).reduce((total, character) => {
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
}

function getBadgeNameFontSize(siteName: string, maxFontSize = BADGE_NAME_MAX_FONT_SIZE): string {
  const widthUnits = estimateTextWidthUnits(siteName)
  const fittedSize = Math.min(maxFontSize, BADGE_TEXT_MAX_WIDTH / Math.max(widthUnits, 1))
  const safeSize = Math.max(BADGE_NAME_MIN_FONT_SIZE, fittedSize)

  return (Math.floor(safeSize * 10) / 10).toString()
}

function tryReadSvgLogo(assetPath: string): string | null {
  const absPath = join(REPO_ROOT, assetPath)
  if (!existsSync(absPath) || !assetPath.toLowerCase().endsWith('.svg')) {
    return null
  }

  return readFileSync(absPath, 'utf-8')
}

function tryLoadBadgeLogoSource(assetPath: string): BadgeLogoSource | null {
  const svg = tryReadSvgLogo(assetPath)
  if (svg) {
    return { kind: 'svg', path: assetPath, svg }
  }

  const raster = loadRasterImage(assetPath)
  if (raster && !isSolidOpaqueSquareRaster(raster)) {
    return { kind: 'raster', path: assetPath, raster }
  }

  return null
}

function resolveBadgeLogoSource(opts: {
  appPackageName: string
  brandingFaviconPath?: string
  brandingLogoPath?: string
}): BadgeLogoSource {
  const candidatePaths = [
    opts.brandingLogoPath,
    opts.brandingFaviconPath,
    `apps/${opts.appPackageName}/public/badge-logo.svg`,
    `apps/${opts.appPackageName}/public/logo.svg`,
    SERP_ARROW_MARK_PATH
  ].filter((path): path is string => Boolean(path))

  for (const candidatePath of candidatePaths) {
    const logoSource = tryLoadBadgeLogoSource(candidatePath)
    if (logoSource) {
      return logoSource
    }
  }

  throw new Error(
    `Missing usable badge logo mark for ${opts.appPackageName}. Add a transparent logo/fallback favicon or keep ${SERP_ARROW_MARK_PATH}.`
  )
}

function crc32(buffer: Buffer): number {
  const table = Array.from({ length: 256 }, (_, index) => {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    return value >>> 0
  })

  let crc = 0xffffffff
  for (const byte of buffer) {
    crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }

  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, 'ascii')
  const length = Buffer.alloc(4)
  const crc = Buffer.alloc(4)

  length.writeUInt32BE(data.length)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])))

  return Buffer.concat([length, typeBuffer, data, crc])
}

function encodePngRgba(image: RasterImage): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(image.width, 0)
  ihdr.writeUInt32BE(image.height, 4)
  ihdr[8] = 8
  ihdr[9] = 6

  const rowStride = image.width * 4
  const raw = Buffer.alloc((rowStride + 1) * image.height)
  for (let row = 0; row < image.height; row += 1) {
    image.rgba.copy(raw, row * (rowStride + 1) + 1, row * rowStride, (row + 1) * rowStride)
  }

  return Buffer.concat([
    Buffer.from(PNG_SIGNATURE, 'hex'),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

function hexColorToRgb(value: string): [number, number, number] {
  const normalized = value.replace(/^#/, '')
  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16)
  ]
}

function buildBadgeRaster(image: RasterImage, fill: string): RasterImage {
  const [red, green, blue] = hexColorToRgb(fill)
  let minX = image.width
  let minY = image.height
  let maxX = -1
  let maxY = -1

  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const alpha = image.rgba[(y * image.width + x) * 4 + 3]
      if (alpha > 8) {
        minX = Math.min(minX, x)
        minY = Math.min(minY, y)
        maxX = Math.max(maxX, x)
        maxY = Math.max(maxY, y)
      }
    }
  }

  if (maxX < minX || maxY < minY) {
    throw new Error('Badge raster logo has no visible pixels.')
  }

  const cropWidth = maxX - minX + 1
  const cropHeight = maxY - minY + 1
  const maxOutputSize = 128
  const scale = Math.min(1, maxOutputSize / Math.max(cropWidth, cropHeight))
  const outputWidth = Math.max(1, Math.round(cropWidth * scale))
  const outputHeight = Math.max(1, Math.round(cropHeight * scale))
  const rgba = Buffer.alloc(outputWidth * outputHeight * 4)

  for (let y = 0; y < outputHeight; y += 1) {
    for (let x = 0; x < outputWidth; x += 1) {
      const sourceX = minX + Math.min(cropWidth - 1, Math.floor(x / scale))
      const sourceY = minY + Math.min(cropHeight - 1, Math.floor(y / scale))
      const sourceOffset = (sourceY * image.width + sourceX) * 4
      const targetOffset = (y * outputWidth + x) * 4

      rgba[targetOffset] = red
      rgba[targetOffset + 1] = green
      rgba[targetOffset + 2] = blue
      rgba[targetOffset + 3] = image.rgba[sourceOffset + 3]
    }
  }

  return { height: outputHeight, rgba, width: outputWidth }
}

function buildInlineRasterLogo(
  raster: RasterImage,
  sourcePath: string,
  fill: string
): BadgeLogoMark {
  const badgeRaster = buildBadgeRaster(raster, fill)
  const dataUri = `data:image/png;base64,${encodePngRgba(badgeRaster).toString('base64')}`

  return {
    markup: `<image data-badge-logo="true" data-badge-logo-source="${escapeSvgAttribute(sourcePath)}" x="${BADGE_ICON_X}" y="${BADGE_ICON_Y}" width="${BADGE_ICON_SIZE}" height="${BADGE_ICON_SIZE}" href="${dataUri}" preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false"/>`
  }
}

function buildInlineSvgLogo(svg: string, sourcePath: string, fill: string): BadgeLogoMark {
  const viewBox = svg.match(/\bviewBox="([^"]+)"/i)?.[1] ?? '0 0 1024 1024'
  const body = svg
    .replace(/<\?xml[^>]*>/gi, '')
    .replace(/<!doctype[^>]*>/gi, '')
    .replace(/<title>[\s\S]*?<\/title>/gi, '')
    .replace(/<svg\b[^>]*>/i, '')
    .replace(/<\/svg>\s*$/i, '')
    .replace(/\s(?:width|height)="[^"]*"/gi, '')
    .replace(/\sfill="[^"]*"/gi, ' fill="currentColor"')
    .trim()

  return {
    markup: `<svg data-badge-logo="true" data-badge-logo-source="${escapeSvgAttribute(sourcePath)}" x="${BADGE_ICON_X}" y="${BADGE_ICON_Y}" width="${BADGE_ICON_SIZE}" height="${BADGE_ICON_SIZE}" viewBox="${escapeSvgAttribute(viewBox)}" color="${fill}" fill="currentColor" aria-hidden="true" focusable="false">
    ${body}
  </svg>`
  }
}

function buildLogoMark(logoSource: BadgeLogoSource, fill: string): BadgeLogoMark {
  if (logoSource.kind === 'svg') {
    return buildInlineSvgLogo(logoSource.svg, logoSource.path, fill)
  }

  return buildInlineRasterLogo(logoSource.raster, logoSource.path, fill)
}

function buildSvg(opts: {
  logoSource: BadgeLogoSource
  siteId: string
  siteName: string
  variant: 'light' | 'dark'
}): string {
  const { logoSource, siteId, siteName, variant } = opts

  const bgFill = variant === 'light' ? '#ffffff' : '#1a1a1a'
  const strokeColor = variant === 'light' ? '#e5e7eb' : '#333333'
  const labelFill = variant === 'light' ? '#000000' : '#ffffff'
  const nameFill = variant === 'light' ? '#000000' : '#eeeeee'
  const iconFill = variant === 'light' ? '#111111' : '#f5f5f5'

  const textX = BADGE_TEXT_X.toString()
  const typography = SITE_TYPOGRAPHY_OVERRIDES[siteId]
  const labelFontSize = typography?.labelFontSize ?? BADGE_LABEL_FONT_SIZE
  const letterSpacingAttribute = typography?.letterSpacing
    ? ` letter-spacing="${escapeSvgAttribute(typography.letterSpacing)}"`
    : ''
  const safeSiteName = escapeSvgText(siteName)
  const safeFullSiteName = escapeSvgText(siteName)
  const nameFontSize = getBadgeNameFontSize(
    siteName,
    typography?.nameMaxFontSize ?? BADGE_NAME_MAX_FONT_SIZE
  )
  const logoMark = buildLogoMark(logoSource, iconFill)

  return `<svg width="${BADGE_WIDTH}" height="${BADGE_HEIGHT}" viewBox="0 0 ${BADGE_WIDTH} ${BADGE_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <title>Featured on ${safeFullSiteName}</title>
  <rect x="1" y="1" width="198" height="48" rx="5" fill="${bgFill}" stroke="${strokeColor}" stroke-width="1"/>
  ${logoMark.markup}
  <text x="${textX}" y="20" font-family="system-ui,-apple-system,sans-serif" font-size="${labelFontSize}" font-weight="500" fill="${labelFill}" opacity="0.8"${letterSpacingAttribute}>FEATURED ON</text>
  <text x="${textX}" y="36" font-family="system-ui,-apple-system,sans-serif" font-size="${nameFontSize}" font-weight="700" fill="${nameFill}"${letterSpacingAttribute}>${safeSiteName}</text>
</svg>`
}

function main(): void {
  const siteIds = Object.keys(siteConfigsById)
  const r2Assets: R2FeaturedBadgeAsset[] = []

  for (const siteId of siteIds) {
    const config = resolveCheckedInSiteConfig(siteId)
    const siteName = config.badges?.featuredOn?.displayName ?? config.site?.name ?? siteId
    const outputDir = join(REPO_ROOT, 'apps', config.build.appPackageName, 'public', 'badge')

    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true })
    }

    const logoSource = config.branding?.logo
    const faviconSource = config.branding?.favicon
    const badgeLogoSource = resolveBadgeLogoSource({
      appPackageName: config.build.appPackageName,
      brandingFaviconPath:
        faviconSource && faviconSource.source === 'local-path' ? faviconSource.path : undefined,
      brandingLogoPath:
        logoSource && logoSource.source === 'local-path' ? logoSource.path : undefined
    })

    for (const variant of ['light', 'dark'] as const) {
      const svg = buildSvg({ logoSource: badgeLogoSource, siteId, siteName, variant })
      const filename = `featured-on-${siteId}-${variant}.svg`
      const outPath = join(outputDir, filename)
      const source = `apps/${config.build.appPackageName}/public/badge/${filename}`
      writeFileSync(outPath, svg, 'utf-8')
      r2Assets.push({
        contentType: 'image/svg+xml',
        height: BADGE_HEIGHT,
        key: `${R2_BADGE_KEY_PREFIX}/${filename}`,
        siteId,
        source,
        variant,
        width: BADGE_WIDTH
      })
      console.log(`  wrote ${source}`)
    }
  }

  const r2MapPath = join(REPO_ROOT, 'scripts', 'r2-featured-badge-assets.json')
  writeFileSync(r2MapPath, `${JSON.stringify(r2Assets, null, 2)}\n`, 'utf-8')
  console.log('  wrote scripts/r2-featured-badge-assets.json')
  console.log(`\nDone — generated ${siteIds.length * 2} badge SVG(s) and the R2 asset map.`)
}

main()

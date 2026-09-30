import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const repoRoot = resolve(dirname(scriptPath), '..')

type NetworkBrandsPathsOptions = {
  homeDir?: string
  repoRoot?: string
}

type SyncNetworkBrandsOptions = {
  sourcePath?: string
  targetPath?: string
}

type RawNetworkBrandsData = {
  brandGroups?: unknown
  brands?: unknown
}

export function getDefaultNetworkBrandsPaths({
  homeDir = homedir(),
  repoRoot: targetRepoRoot = repoRoot
}: NetworkBrandsPathsOptions = {}) {
  return {
    sourcePath: join(homeDir, 'dev', 'repos', 'serp', 'docs', 'websites', 'pages', 'brands.json'),
    targetPath: join(targetRepoRoot, 'packages', 'web-core', 'src', 'data', 'network-brands.json')
  }
}

export function syncNetworkBrands({ sourcePath, targetPath }: SyncNetworkBrandsOptions = {}) {
  const defaults = getDefaultNetworkBrandsPaths()
  const resolvedSourcePath = sourcePath ?? defaults.sourcePath
  const resolvedTargetPath = targetPath ?? defaults.targetPath
  const parsed = readNetworkBrandsJson(resolvedSourcePath)

  mkdirSync(dirname(resolvedTargetPath), { recursive: true })
  writeFileSync(resolvedTargetPath, `${JSON.stringify(parsed, null, 2)}\n`)

  return {
    brandCount: Object.keys(parsed.brands).length,
    sourcePath: resolvedSourcePath,
    targetPath: resolvedTargetPath
  }
}

function readNetworkBrandsJson(sourcePath: string): {
  brandGroups?: unknown
  brands: Record<string, unknown>
} {
  const parsed = JSON.parse(readFileSync(sourcePath, 'utf8')) as RawNetworkBrandsData

  validateNetworkBrandsData(parsed, sourcePath)

  return {
    ...parsed,
    brands: parsed.brands as Record<string, unknown>
  }
}

function normalizeNetworkBrandUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Brand url must be a non-empty string.')
  }

  const url = new URL(value)

  if (url.protocol !== 'https:') {
    throw new Error(`Brand url must use https: ${value}`)
  }

  if (url.username || url.password) {
    throw new Error(`Brand url cannot include credentials: ${value}`)
  }

  if (url.search || url.hash) {
    throw new Error(`Brand url cannot include query params or fragments: ${value}`)
  }

  const normalizedPathname = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '')

  return `https://${url.host.toLowerCase()}${normalizedPathname}`
}

function validateNetworkBrandsData(data: RawNetworkBrandsData, sourcePath: string): void {
  if (!data.brands || typeof data.brands !== 'object' || Array.isArray(data.brands)) {
    throw new Error(`Network brands source "${sourcePath}" must contain a brands object`)
  }

  const seenUrls = new Map<string, string>()

  for (const [slug, entry] of Object.entries(data.brands)) {
    if (!slug) {
      throw new Error('Brand slug cannot be empty.')
    }

    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Brand entry for ${slug} must be an object.`)
    }

    const brand = entry as { name?: unknown; url?: unknown }

    if (typeof brand.name !== 'string' || !brand.name.trim()) {
      throw new Error(`Brand entry for ${slug} must include a non-empty name.`)
    }

    const normalizedUrl = normalizeNetworkBrandUrl(brand.url)
    const existingSlug = seenUrls.get(normalizedUrl)

    if (existingSlug) {
      throw new Error(
        `Duplicate brand url detected for ${slug} and ${existingSlug}: ${normalizedUrl}`
      )
    }

    seenUrls.set(normalizedUrl, slug)
  }

  if (data.brandGroups === undefined) {
    return
  }

  if (
    !data.brandGroups ||
    typeof data.brandGroups !== 'object' ||
    Array.isArray(data.brandGroups)
  ) {
    throw new Error('Network brands brandGroups must be an object when present.')
  }

  const brandSlugs = new Set(Object.keys(data.brands))

  for (const [groupName, groupSlugs] of Object.entries(data.brandGroups)) {
    if (!groupName) {
      throw new Error('Brand group name cannot be empty.')
    }

    if (!Array.isArray(groupSlugs)) {
      throw new Error(`Brand group ${groupName} must be an array of brand slugs.`)
    }

    for (const groupSlug of groupSlugs) {
      if (typeof groupSlug !== 'string' || !groupSlug.trim()) {
        throw new Error(`Brand group ${groupName} must only include non-empty brand slugs.`)
      }

      if (!brandSlugs.has(groupSlug)) {
        throw new Error(`Brand group ${groupName} references unknown brand slug: ${groupSlug}`)
      }
    }
  }
}

function readOption(name: string): string | undefined {
  const index = process.argv.indexOf(name)

  if (index === -1) {
    return undefined
  }

  return process.argv[index + 1]
}

const invokedAsScript =
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === realpathSync(scriptPath)

if (invokedAsScript) {
  const result = syncNetworkBrands({
    sourcePath: readOption('--source'),
    targetPath: readOption('--target')
  })

  console.log(
    `[network-brands] synced ${result.brandCount} brands from ${result.sourcePath} to ${result.targetPath}`
  )
}

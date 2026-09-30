import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

interface LegacyCategory {
  description?: unknown
  name?: unknown
  slug?: unknown
}

interface LegacyProductRecord {
  content?: { body?: unknown; faq?: unknown }
  featured?: unknown
  media?: { images?: unknown; logo?: unknown; video?: unknown }
  product?: {
    categories?: unknown
    productPage?: unknown
    slug?: unknown
    tagline?: unknown
    title?: unknown
  }
  relatedLinks?: unknown
}

export interface MigrationPreflightReport {
  adapter: {
    defaultCategory: string
    featuredCount: number
    kind: 'trial-products-json'
    publishedAt: string
  } | null
  categoryCount: number
  checksums: Record<string, string>
  generatedAt: string
  issues: string[]
  listingCount: number
  readyForMapping: boolean
  siteId: string
  sourceGit: {
    branch: string | null
    clean: boolean
    commit: string
    remote: string
  } | null
  sourceRoot: string
  sourceSiteDirectory: string
  supportingFiles: Record<string, boolean>
  warnings: string[]
}

interface TrialProductsAdapter {
  defaultCategory: string
  featuredCount: number
  kind: 'trial-products-json'
  publishedAt: string
}

const SITE_ID_PATTERN = /^[a-z0-9][a-z0-9.-]+$/u
const SLUG_PATTERN = /^[a-z0-9][a-z0-9.-]*$/u

function checksum(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function parseJson(path: string, label: string, issues: string[]): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch (error) {
    issues.push(
      `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    )
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isHttpUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function propertyName(node: ts.PropertyName): string | null {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text
  return null
}

function objectProperty(
  object: ts.ObjectLiteralExpression,
  name: string
): ts.PropertyAssignment | null {
  const matches = object.properties.filter(
    (property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) && propertyName(property.name) === name
  )
  return matches.length === 1 ? matches[0] : null
}

function stringLiteralProperty(object: ts.ObjectLiteralExpression, name: string): string | null {
  const property = objectProperty(object, name)
  return property && ts.isStringLiteral(property.initializer) ? property.initializer.text : null
}

function parseTrialProductsAdapter(path: string, issues: string[]): TrialProductsAdapter | null {
  if (!existsSync(path)) return null
  const source = readFileSync(path, 'utf8')
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )
  if (sourceFile.parseDiagnostics.length > 0) {
    issues.push('site config contains TypeScript syntax errors and cannot be inspected safely.')
    return null
  }
  const listingSources: ts.ObjectLiteralElementLike[] = []
  const visit = (node: ts.Node): void => {
    if (
      (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
      propertyName(node.name) === 'listingSource'
    ) {
      listingSources.push(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  if (listingSources.length === 0) return null
  if (
    listingSources.length !== 1 ||
    !ts.isPropertyAssignment(listingSources[0]) ||
    !ts.isObjectLiteralExpression(listingSources[0].initializer)
  ) {
    issues.push(
      'site config must contain exactly one static content.listingSource object for migration.'
    )
    return null
  }
  const listingSource = listingSources[0].initializer
  const listingSourceParent = listingSources[0].parent
  const contentProperty =
    ts.isObjectLiteralExpression(listingSourceParent) && listingSourceParent.parent
  const siteConfigObject =
    contentProperty && ts.isPropertyAssignment(contentProperty) ? contentProperty.parent : null
  const siteConfigDeclaration =
    siteConfigObject && ts.isObjectLiteralExpression(siteConfigObject)
      ? siteConfigObject.parent
      : null
  const siteConfigStatement =
    siteConfigDeclaration && ts.isVariableDeclaration(siteConfigDeclaration)
      ? siteConfigDeclaration.parent.parent
      : null
  if (
    !contentProperty ||
    !ts.isPropertyAssignment(contentProperty) ||
    propertyName(contentProperty.name) !== 'content' ||
    !siteConfigStatement ||
    !ts.isVariableStatement(siteConfigStatement) ||
    !siteConfigStatement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
  ) {
    issues.push(
      'listingSource must be declared directly under the exported site config content object.'
    )
    return null
  }
  const kind = stringLiteralProperty(listingSource, 'kind')
  if (kind !== 'trial-products-json') {
    issues.push(
      `Unsupported static content.listingSource kind for migration: ${kind || 'non-literal or missing'}.`
    )
    return null
  }
  const category = stringLiteralProperty(listingSource, 'category')
  const featuredCountProperty = objectProperty(listingSource, 'featuredCount')
  const featuredCount =
    featuredCountProperty && ts.isNumericLiteral(featuredCountProperty.initializer)
      ? Number(featuredCountProperty.initializer.text)
      : null
  const publishedAt = stringLiteralProperty(listingSource, 'publishedAt')
  const publishedAtIsValid =
    publishedAt !== null &&
    /^\d{4}-\d{2}-\d{2}$/u.test(publishedAt) &&
    new Date(`${publishedAt}T00:00:00.000Z`).toISOString().slice(0, 10) === publishedAt
  if (
    !category ||
    !SLUG_PATTERN.test(category) ||
    featuredCount === null ||
    !Number.isSafeInteger(featuredCount) ||
    featuredCount < 0 ||
    featuredCount > 10_000 ||
    !publishedAtIsValid
  ) {
    issues.push(
      'trial-products-json content.listingSource must statically declare a valid category, featuredCount from 0 to 10000, and calendar publishedAt date.'
    )
    return null
  }
  return {
    defaultCategory: category,
    featuredCount,
    kind: 'trial-products-json',
    publishedAt: publishedAt as string
  }
}

function inspectSourceGit(
  sourceRoot: string,
  issues: string[]
): MigrationPreflightReport['sourceGit'] {
  try {
    const run = (args: string[]): string =>
      execFileSync('git', ['-C', sourceRoot, ...args], { encoding: 'utf8' }).trim()
    const status = run(['status', '--porcelain', '--untracked-files=normal'])
    const sourceGit = {
      branch: run(['branch', '--show-current']) || null,
      clean: status === '',
      commit: run(['rev-parse', 'HEAD']),
      remote: run(['remote', 'get-url', 'origin'])
    }
    if (!sourceGit.clean) {
      issues.push('Migration source Git checkout must be clean at the cutoff commit.')
    }
    return sourceGit
  } catch (error) {
    issues.push(
      `Migration source must be a Git checkout with an origin remote: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
    return null
  }
}

function validateCategories(
  source: unknown,
  issues: string[],
  warnings: string[]
): { count: number; slugs: Set<string> } {
  if (!Array.isArray(source)) {
    issues.push('Category source must be an array.')
    return { count: 0, slugs: new Set() }
  }
  const slugs = new Set<string>()
  source.forEach((raw, index) => {
    const category = raw as LegacyCategory
    if (!isRecord(raw)) {
      issues.push(`Category ${index} must be an object.`)
      return
    }
    if (typeof category.slug !== 'string' || !SLUG_PATTERN.test(category.slug)) {
      issues.push(`Category ${index} has an invalid slug.`)
      return
    }
    if (slugs.has(category.slug)) issues.push(`Duplicate category slug: ${category.slug}`)
    slugs.add(category.slug)
    if (typeof category.name !== 'string' || category.name.trim() === '') {
      issues.push(`Category ${category.slug} has no name.`)
    }
    if (typeof category.description !== 'string' || category.description.trim() === '') {
      warnings.push(`Category ${category.slug} has no description.`)
    }
  })
  return { count: source.length, slugs }
}

function validateProducts(
  source: unknown,
  categorySlugs: Set<string>,
  issues: string[],
  warnings: string[],
  adapter: TrialProductsAdapter | null
): number {
  if (!isRecord(source)) {
    issues.push('Product source must be an object keyed by slug.')
    return 0
  }
  for (const [key, raw] of Object.entries(source)) {
    if (!SLUG_PATTERN.test(key)) issues.push(`Product map key is not a valid slug: ${key}`)
    if (!isRecord(raw)) {
      issues.push(`Product ${key} must be an object.`)
      continue
    }
    const record = raw as LegacyProductRecord
    if (!isRecord(record.product)) {
      issues.push(`Product ${key} has no product metadata object.`)
      continue
    }
    if (record.product.slug !== key) {
      issues.push(`Product ${key} declares mismatched slug ${String(record.product.slug)}.`)
    }
    if (typeof record.product.title !== 'string' || record.product.title.trim() === '') {
      issues.push(`Product ${key} has no title.`)
    }
    if (typeof record.product.tagline !== 'string' || record.product.tagline.trim() === '') {
      issues.push(`Product ${key} has no tagline.`)
    }
    if (!isHttpUrl(record.product.productPage)) {
      issues.push(`Product ${key} has an invalid productPage URL.`)
    }
    const categories = record.product.categories
    const usesAdapterDefault =
      adapter !== null &&
      (categories === undefined || (Array.isArray(categories) && categories.length === 0))
    if (usesAdapterDefault) {
      if (!categorySlugs.has(adapter.defaultCategory)) {
        issues.push(
          `Product ${key} requires missing adapter default category ${adapter.defaultCategory}.`
        )
      }
    } else if (
      !Array.isArray(categories) ||
      categories.length === 0 ||
      categories.some(category => typeof category !== 'string')
    ) {
      issues.push(`Product ${key} must declare at least one category.`)
    } else {
      const memberships = categories as string[]
      if (new Set(memberships).size !== memberships.length) {
        issues.push(`Product ${key} repeats a category membership.`)
      }
      for (const category of memberships) {
        if (!categorySlugs.has(category)) {
          issues.push(`Product ${key} references missing category ${category}.`)
        }
      }
    }
    if (!isRecord(record.content) || typeof record.content.body !== 'string') {
      warnings.push(`Product ${key} has no long-form body.`)
    }
    if (record.relatedLinks !== undefined && !Array.isArray(record.relatedLinks)) {
      issues.push(`Product ${key} relatedLinks must be an array.`)
    }
    if (record.media?.images !== undefined && !Array.isArray(record.media.images)) {
      issues.push(`Product ${key} media.images must be an array.`)
    }
  }
  if (adapter) {
    const implicitCount = Object.values(source).filter(raw => {
      if (!isRecord(raw)) return false
      const product = (raw as LegacyProductRecord).product
      if (!isRecord(product)) return false
      return (
        product.categories === undefined ||
        (Array.isArray(product.categories) && product.categories.length === 0)
      )
    }).length
    if (implicitCount > 0) {
      warnings.push(
        `${implicitCount} products use trial-products-json default category ${adapter.defaultCategory}.`
      )
    }
  }
  return Object.keys(source).length
}

export function inspectLegacySite(
  sourceRootInput: string,
  siteId: string,
  generatedAt = new Date().toISOString()
): MigrationPreflightReport {
  if (!SITE_ID_PATTERN.test(siteId)) throw new Error(`Invalid site ID: ${siteId}`)
  const sourceRoot = realpathSync(resolve(sourceRootInput))
  const sourceSiteDirectory = resolve(sourceRoot, 'sites', siteId)
  const currentRoot = realpathSync(resolve('.'))
  if (sourceSiteDirectory.startsWith(`${currentRoot}/`)) {
    throw new Error('Migration source must be external to this D1 repository.')
  }

  const productPath = resolve(sourceSiteDirectory, 'products.json')
  const categoryPath = resolve(sourceSiteDirectory, 'categories.json')
  const siteConfigPath = resolve(sourceSiteDirectory, 'site-config.ts')
  const issues: string[] = []
  const warnings: string[] = []
  const sourceGit = inspectSourceGit(sourceRoot, issues)
  if (!existsSync(productPath)) issues.push(`Missing source file: ${productPath}`)
  if (!existsSync(categoryPath)) issues.push(`Missing source file: ${categoryPath}`)

  const supportingFiles = {
    assets: existsSync(resolve(sourceSiteDirectory, 'assets')),
    readme: existsSync(resolve(sourceSiteDirectory, 'README.md')),
    siteConfig: existsSync(resolve(sourceSiteDirectory, 'site-config.ts')),
    siteContent: existsSync(resolve(sourceSiteDirectory, 'site-content.ts'))
  }
  const adapter = parseTrialProductsAdapter(siteConfigPath, issues)
  for (const [name, present] of Object.entries(supportingFiles)) {
    if (!present) warnings.push(`Supporting source ${name} is absent.`)
  }

  let categoryCount = 0
  let listingCount = 0
  const checksums: Record<string, string> = {}
  if (existsSync(categoryPath)) {
    checksums.categories = checksum(categoryPath)
    const validated = validateCategories(
      parseJson(categoryPath, 'Category source', issues),
      issues,
      warnings
    )
    categoryCount = validated.count
    if (existsSync(productPath)) {
      checksums.products = checksum(productPath)
      listingCount = validateProducts(
        parseJson(productPath, 'Product source', issues),
        validated.slugs,
        issues,
        warnings,
        adapter
      )
    }
  }
  for (const [name, relativePath] of [
    ['siteConfig', 'site-config.ts'],
    ['siteContent', 'site-content.ts']
  ] as const) {
    const path = resolve(sourceSiteDirectory, relativePath)
    if (existsSync(path)) checksums[name] = checksum(path)
  }

  return {
    adapter,
    categoryCount,
    checksums,
    generatedAt,
    issues: [...new Set(issues)].sort(),
    listingCount,
    readyForMapping: issues.length === 0,
    siteId,
    sourceGit,
    sourceRoot,
    sourceSiteDirectory,
    supportingFiles,
    warnings: [...new Set(warnings)].sort()
  }
}

interface CliOptions {
  output?: string
  siteId: string
  sourceRoot: string
}

function parseArguments(args: string[]): CliOptions {
  const values = args.filter(value => value !== '--')
  const valueFor = (flag: string): string | undefined => {
    const index = values.indexOf(flag)
    return index === -1 ? undefined : values[index + 1]
  }
  const sourceRoot = valueFor('--source-root')
  const siteId = valueFor('--site-id')
  if (!sourceRoot || !siteId) {
    throw new Error(
      'Usage: pnpm migration:preflight -- --source-root /absolute/json-directory --site-id example.com [--output report.json]'
    )
  }
  return { sourceRoot, siteId, output: valueFor('--output') }
}

function main(): void {
  const options = parseArguments(process.argv.slice(2))
  const report = inspectLegacySite(options.sourceRoot, options.siteId)
  const output = `${JSON.stringify(report, null, 2)}\n`
  if (options.output) {
    const outputPath = resolve(options.output)
    if (!existsSync(dirname(outputPath))) {
      throw new Error(`Output directory does not exist: ${dirname(outputPath)}`)
    }
    writeFileSync(outputPath, output)
    console.log(outputPath)
  } else {
    process.stdout.write(output)
  }
  if (!report.readyForMapping) process.exitCode = 1
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

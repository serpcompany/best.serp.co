import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stringify } from 'yaml'
import { z } from 'zod'
import { resolveSiteTarget } from '../site-targets'
import { inspectLegacySite } from './preflight'

const httpUrl = z
  .string()
  .url()
  .refine(value => value.startsWith('http://') || value.startsWith('https://'))
const publicAssetUrl = z
  .string()
  .refine(value => value.startsWith('/') || httpUrl.safeParse(value).success)
const slug = z.string().regex(/^[a-z0-9][a-z0-9.-]*$/u)

const categorySchema = z
  .object({
    description: z.string().optional(),
    name: z.string().min(1),
    slug
  })
  .strict()

const faqSchema = z.object({ answer: z.string(), question: z.string() }).strict()
const resourceSchema = z.object({ label: z.string(), url: httpUrl }).strict()
const productRecordSchema = z
  .object({
    content: z
      .object({
        body: z.string().optional(),
        faq: z.array(faqSchema).optional()
      })
      .strict()
      .optional(),
    featured: z.boolean().optional(),
    media: z
      .object({
        images: z.array(publicAssetUrl).optional(),
        logo: publicAssetUrl.optional(),
        video: publicAssetUrl.optional()
      })
      .strict()
      .optional(),
    product: z
      .object({
        categories: z.array(slug).optional(),
        productPage: httpUrl,
        slug,
        tagline: z.string().min(1),
        title: z.string().min(1)
      })
      .strict(),
    relatedLinks: z.array(resourceSchema).optional()
  })
  .strict()

const productsSchema = z.record(slug, productRecordSchema)
const categoriesSchema = z.array(categorySchema)

interface NormalizedListing {
  categories: string[]
  checksum: string
  content: string | null
  description: string
  displayOrder: number
  faqs: Array<{ answer: string; question: string }>
  featured: boolean
  id: string
  media: Array<{ kind: 'image' | 'logo' | 'video'; url: string }>
  name: string
  resources: Array<{ label: string; url: string }>
  slug: string
  sourceIdentity: string
  website: string
}

interface GeneratorOptions {
  outputRoot: string
  siteId: string
  sourceRoot: string
}

interface GeneratedArtifact {
  batchCount: number
  checksum: string
  listingCount: number
}

const forbiddenHelpCenter = /\bhttps?:\/\/help\.serp\.co\/en(?:\/|(?=$)|[?#])/iu

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function cleanString(value: string | undefined): string | undefined {
  const cleaned = value?.trim()
  return cleaned || undefined
}

function escapeMdx(value: string): string {
  return value.replaceAll('{', '\\{').replaceAll('}', '\\}')
}

function sql(value: string | null): string {
  return value === null ? 'NULL' : `'${value.replaceAll("'", "''")}'`
}

function writeGenerated(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, value)
}

function listFiles(directory: string): string[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true })
    .flatMap(entry => {
      const path = resolve(directory, entry.name)
      return entry.isDirectory() ? listFiles(path) : [path]
    })
    .sort()
}

function parseArgs(args: string[]): GeneratorOptions {
  const values = args.filter(value => value !== '--')
  const valueFor = (flag: string): string | undefined => {
    const index = values.indexOf(flag)
    return index < 0 ? undefined : values[index + 1]
  }
  const sourceRoot = valueFor('--source-root')
  const siteId = valueFor('--site-id')
  const outputRoot = valueFor('--output-root') || '.'
  if (!sourceRoot || !siteId) {
    throw new Error(
      'Usage: pnpm migration:generate -- --source-root /absolute/json-directory --site-id example.com [--output-root path]'
    )
  }
  return { outputRoot: resolve(outputRoot), siteId, sourceRoot: resolve(sourceRoot) }
}

function buildContent(
  bodyInput: string | undefined,
  faqs: Array<{ answer: string; question: string }>
): string | null {
  const body = cleanString(bodyInput)
  const faqSection =
    faqs.length === 0
      ? ''
      : `## FAQ\n\n${faqs
          .map(entry => `### ${escapeMdx(entry.question)}\n\n${escapeMdx(entry.answer)}`)
          .join('\n\n')}`
  return [body || '', faqSection].filter(Boolean).join('\n\n') || null
}

function normalize(
  products: z.infer<typeof productsSchema>,
  defaultCategory: string,
  featuredCount: number,
  siteId: string,
  sourceCommit: string,
  sourceChecksum: string
): {
  listings: NormalizedListing[]
  report: Record<string, unknown>
} {
  const transformations = {
    excludedRecords: [] as string[],
    filteredFaqs: [] as Array<{ index: number; slug: string }>,
    filteredResourceLinks: [] as Array<{ index: number; slug: string }>,
    implicitCategory: [] as string[],
    retainedSourceInconsistencies: ['launchbuzz.io'],
    trimmedFields: [] as Array<{ field: string; slug: string }>,
    trailingSlashRemoved: [] as string[]
  }
  const normalized = Object.entries(products).map(([mapKey, record], sourceIndex) => {
    if (record.product.slug !== mapKey) {
      throw new Error(`Product ${mapKey} declares mismatched slug ${record.product.slug}.`)
    }
    const clean = (field: string, value: string): string => {
      const result = value.trim()
      if (result !== value) transformations.trimmedFields.push({ field, slug: mapKey })
      if (!result) throw new Error(`Product ${mapKey} has empty ${field}.`)
      return result
    }
    const explicitCategories = record.product.categories?.map(value => clean('category', value))
    const categories =
      explicitCategories && explicitCategories.length > 0
        ? [...new Set(explicitCategories)]
        : [defaultCategory]
    if (!explicitCategories?.length) transformations.implicitCategory.push(mapKey)
    const websiteInput = clean('product.productPage', record.product.productPage)
    const website = websiteInput.replace(/\/$/u, '')
    if (website !== websiteInput) transformations.trailingSlashRemoved.push(mapKey)
    const faqs = (record.content?.faq || []).flatMap((entry, index) => {
      const question = cleanString(entry.question)
      const answer = cleanString(entry.answer)
      if (!question || !answer || forbiddenHelpCenter.test(`${question}\n${answer}`)) {
        transformations.filteredFaqs.push({ index, slug: mapKey })
        return []
      }
      return [{ answer, question }]
    })
    const resources = (record.relatedLinks || []).flatMap((entry, index) => {
      const label = cleanString(entry.label)
      const url = cleanString(entry.url)
      if (!label || !url || forbiddenHelpCenter.test(url)) {
        transformations.filteredResourceLinks.push({ index, slug: mapKey })
        return []
      }
      return [{ label, url }]
    })
    const media = [
      ...(record.media?.logo ? [{ kind: 'logo' as const, url: record.media.logo.trim() }] : []),
      ...(record.media?.images || []).map(url => ({ kind: 'image' as const, url: url.trim() })),
      ...(record.media?.video ? [{ kind: 'video' as const, url: record.media.video.trim() }] : [])
    ]
    const id = `lst_${sha256(`${siteId}\0legacy-product-map\0${mapKey}`).slice(0, 24)}`
    const sourceIdentity = `${siteId}:${sourceCommit}:${sourceChecksum}:${mapKey}`
    const target = {
      categories,
      content: buildContent(record.content?.body, faqs),
      description: clean('product.tagline', record.product.tagline),
      faqs,
      featured: record.featured ?? sourceIndex < featuredCount,
      id,
      media,
      name: clean('product.title', record.product.title),
      resources,
      slug: mapKey,
      sourceIdentity,
      website
    }
    return {
      ...target,
      checksum: sha256(JSON.stringify(target)),
      displayOrder: 0
    }
  })
  normalized.sort((left, right) => left.name.localeCompare(right.name))
  normalized.forEach((listing, index) => {
    listing.displayOrder = index
  })
  return {
    listings: normalized,
    report: {
      ...transformations,
      inputRecords: normalized.length,
      outputRecords: normalized.length,
      unexplainedDrops: 0
    }
  }
}

function listingStatements(
  listing: NormalizedListing,
  siteId: string,
  publishedAt: string,
  sourceUpdatedAt: string
): string[] {
  const statements = [
    `INSERT INTO listings (id, site_id, slug, name, description, website, content, entity_type, priority, is_unofficial, is_featured, is_active, status, published_at, display_order, source_kind, source_identity, source_updated_at, checksum, created_at, updated_at) VALUES (${sql(listing.id)}, ${sql(siteId)}, ${sql(listing.slug)}, ${sql(listing.name)}, ${sql(listing.description)}, ${sql(listing.website)}, ${sql(listing.content)}, NULL, NULL, 0, ${listing.featured ? 1 : 0}, 1, 'draft', ${sql(publishedAt)}, ${listing.displayOrder}, 'legacy-json-migration-v1', ${sql(listing.sourceIdentity)}, ${sql(sourceUpdatedAt)}, ${sql(listing.checksum)}, ${sql(sourceUpdatedAt)}, ${sql(sourceUpdatedAt)});`
  ]
  listing.categories.forEach((category, index) => {
    statements.push(
      `INSERT INTO listing_categories (listing_id, category_id, sort_order, is_primary) SELECT ${sql(listing.id)}, id, ${index}, ${index === 0 ? 1 : 0} FROM categories WHERE site_id = ${sql(siteId)} AND slug = ${sql(category)};`
    )
  })
  listing.media.forEach((media, index) => {
    statements.push(
      `INSERT INTO listing_media (listing_id, kind, url, sort_order) VALUES (${sql(listing.id)}, ${sql(media.kind)}, ${sql(media.url)}, ${index});`
    )
  })
  listing.resources.forEach((resource, index) => {
    statements.push(
      `INSERT INTO listing_resource_links (listing_id, label, url, sort_order) VALUES (${sql(listing.id)}, ${sql(resource.label)}, ${sql(resource.url)}, ${index});`
    )
  })
  listing.faqs.forEach((faq, index) => {
    statements.push(
      `INSERT INTO listing_faqs (listing_id, question, answer, sort_order) VALUES (${sql(listing.id)}, ${sql(faq.question)}, ${sql(faq.answer)}, ${index});`
    )
  })
  return statements
}

function batchStatements(groups: string[][], maxBytes = 90_000): string[] {
  const batches: string[] = []
  let current: string[] = []
  let bytes = 0
  for (const group of groups) {
    const text = `${group.join('\n')}\n`
    const groupBytes = Buffer.byteLength(text)
    if (groupBytes > maxBytes) throw new Error('One listing exceeds the D1 import batch limit.')
    if (current.length > 0 && bytes + groupBytes > maxBytes) {
      batches.push(`${current.join('\n')}\n`)
      current = []
      bytes = 0
    }
    current.push(text.trimEnd())
    bytes += groupBytes
  }
  if (current.length > 0) batches.push(`${current.join('\n')}\n`)
  return batches
}

export function generateInitialArtifact(options: GeneratorOptions): GeneratedArtifact {
  const target = resolveSiteTarget(options.siteId)
  const preflight = inspectLegacySite(options.sourceRoot, target.siteId, '1970-01-01T00:00:00.000Z')
  if (!preflight.readyForMapping || !preflight.adapter || !preflight.sourceGit) {
    throw new Error(`Source preflight is not ready: ${preflight.issues.join(' ')}`)
  }
  const sourceSiteDirectory = resolve(options.sourceRoot, 'sites', target.siteId)
  const categories = categoriesSchema.parse(
    JSON.parse(readFileSync(resolve(sourceSiteDirectory, 'categories.json'), 'utf8'))
  )
  const products = productsSchema.parse(
    JSON.parse(readFileSync(resolve(sourceSiteDirectory, 'products.json'), 'utf8'))
  )
  const sourceUpdatedAt = new Date(
    execFileSync(
      'git',
      ['-C', options.sourceRoot, 'show', '-s', '--format=%cI', preflight.sourceGit.commit],
      { encoding: 'utf8' }
    ).trim()
  ).toISOString()
  const { listings, report: normalizationReport } = normalize(
    products,
    preflight.adapter.defaultCategory,
    preflight.adapter.featuredCount,
    target.siteId,
    preflight.sourceGit.commit,
    preflight.checksums.products
  )
  const categorySlugs = new Set(categories.map(category => category.slug))
  for (const listing of listings) {
    for (const membership of listing.categories) {
      if (!categorySlugs.has(membership)) {
        throw new Error(`Listing ${listing.slug} references missing category ${membership}.`)
      }
    }
  }
  const stableIds = new Set(listings.map(listing => listing.id))
  if (stableIds.size !== listings.length) throw new Error('Stable listing ID collision detected.')

  const targetChecksum = sha256(
    JSON.stringify({
      categories,
      listings: listings.map(listing => ({
        checksum: listing.checksum,
        displayOrder: listing.displayOrder,
        id: listing.id,
        slug: listing.slug
      })),
      siteId: target.siteId,
      version: 1
    })
  )
  const artifactId = target.parityReportPath
    .split('/')
    .at(-1)
    ?.replace(/-parity\.yaml$/u, '') as string
  const setup = [
    'PRAGMA foreign_keys = ON;',
    `INSERT INTO sites (id, created_at, updated_at) VALUES (${sql(target.siteId)}, ${sql(sourceUpdatedAt)}, ${sql(sourceUpdatedAt)});`,
    ...categories.map(
      (category, index) =>
        `INSERT INTO categories (site_id, slug, name, description, sort_order, is_active, created_at, updated_at) VALUES (${sql(target.siteId)}, ${sql(category.slug)}, ${sql(category.name.trim())}, ${sql(category.description?.trim() || '')}, ${index}, 1, ${sql(sourceUpdatedAt)}, ${sql(sourceUpdatedAt)});`
    ),
    `INSERT INTO migration_runs (id, site_id, schema_version, manifest_identity, input_checksum, target_checksum, affected_records, outcome, started_at, completed_at) VALUES (${sql(`migration-${artifactId}`)}, ${sql(target.siteId)}, 1, ${sql(artifactId)}, ${sql(preflight.checksums.products)}, ${sql(targetChecksum)}, ${listings.length}, 'started', ${sql(sourceUpdatedAt)}, NULL);`
  ]
  const listingGroups = listings.map(listing =>
    listingStatements(
      listing,
      target.siteId,
      preflight.adapter?.publishedAt as string,
      sourceUpdatedAt
    )
  )
  const finish = [
    ...listings.map(
      listing =>
        `UPDATE listings SET status = 'approved' WHERE id = ${sql(listing.id)} AND site_id = ${sql(target.siteId)};`
    ),
    `INSERT INTO publication_state (site_id, version, manifest_id, checksum, published_at) VALUES (${sql(target.siteId)}, 1, ${sql(artifactId)}, ${sql(targetChecksum)}, ${sql(sourceUpdatedAt)});`,
    `UPDATE migration_runs SET outcome = 'succeeded', completed_at = ${sql(sourceUpdatedAt)} WHERE id = ${sql(`migration-${artifactId}`)} AND site_id = ${sql(target.siteId)};`
  ]
  const batches = [
    `${setup.join('\n')}\n`,
    ...batchStatements(listingGroups),
    `${finish.join('\n')}\n`
  ]
  const allSql = `${batches.join('\n')}`
  const artifactPath = target.parityReportPath.replace(/-parity\.yaml$/u, '.sql')
  writeGenerated(resolve(options.outputRoot, artifactPath), allSql)
  batches.forEach((batch, index) => {
    writeGenerated(
      resolve(
        options.outputRoot,
        target.artifactBatchDirectory,
        `${String(index + 1).padStart(4, '0')}.sql`
      ),
      batch
    )
  })

  const sourcePublic = resolve(options.sourceRoot, 'apps', target.siteId, 'public')
  const publicFiles = listFiles(sourcePublic)
  const referencedLocalAssets = [
    ...new Set(
      listings
        .flatMap(listing => listing.media.map(media => media.url))
        .filter(url => url.startsWith('/'))
    )
  ].sort()
  const assetInventory = {
    copiedPublicAssets: publicFiles.map(path => ({
      bytes: statSync(path).size,
      checksum: sha256(readFileSync(path)),
      path: relative(sourcePublic, path)
    })),
    copiedPublicTreeChecksum: sha256(
      publicFiles
        .map(path => `${relative(sourcePublic, path)}\0${sha256(readFileSync(path))}`)
        .join('\n')
    ),
    missingReferencedLocalAssets: referencedLocalAssets.filter(
      url => !existsSync(resolve(sourcePublic, url.slice(1)))
    ),
    referencedLocalAssets: referencedLocalAssets.length,
    sourceCommit: preflight.sourceGit.commit,
    sourceRemote: preflight.sourceGit.remote
  }
  const evidenceRoot = resolve(options.outputRoot, 'tmp/migrations', target.siteId)
  writeGenerated(
    resolve(evidenceRoot, 'normalization-report.json'),
    `${JSON.stringify(
      {
        sourceCommit: preflight.sourceGit.commit,
        sourceFileChecksums: preflight.checksums,
        ...normalizationReport
      },
      null,
      2
    )}\n`
  )
  writeGenerated(
    resolve(evidenceRoot, 'asset-inventory.json'),
    `${JSON.stringify(assetInventory, null, 2)}\n`
  )

  const parity = {
    artifact: {
      batchChecksums: batches.map(batch => sha256(batch)),
      id: artifactId,
      sqlChecksum: sha256(allSql)
    },
    mapping: {
      adapter: preflight.adapter,
      excludedRecords: 0,
      stableIdAlgorithm: 'sha256(site_id + NUL + legacy-product-map + NUL + source map key)[0:24]',
      version: 1
    },
    parity: {
      categories: categories.map((category, order) => ({
        description: category.description?.trim() || '',
        name: category.name.trim(),
        order,
        slug: category.slug
      })),
      categoryMembershipCount: listings.reduce(
        (total, listing) => total + listing.categories.length,
        0
      ),
      exactSlugSet: listings.map(listing => listing.slug).sort(),
      faqCount: listings.reduce((total, listing) => total + listing.faqs.length, 0),
      featuredCount: listings.filter(listing => listing.featured).length,
      importBatches: batches.length,
      listingRows: listings
        .map(listing => ({
          checksum: listing.checksum,
          id: listing.id,
          slug: listing.slug
        }))
        .sort((left, right) => left.slug.localeCompare(right.slug)),
      mediaCount: listings.reduce((total, listing) => total + listing.media.length, 0),
      primaryCategoryCount: listings.length,
      resourceLinkCount: listings.reduce((total, listing) => total + listing.resources.length, 0)
    },
    source: {
      checksums: preflight.checksums,
      commit: preflight.sourceGit.commit,
      remote: preflight.sourceGit.remote,
      siteId: target.siteId
    },
    target: {
      categoryCount: categories.length,
      checksum: targetChecksum,
      listingCount: listings.length,
      publicationVersion: 1,
      siteId: target.siteId
    }
  }
  writeGenerated(
    resolve(options.outputRoot, target.parityReportPath),
    stringify(parity, { lineWidth: 0 })
  )

  return {
    batchCount: batches.length,
    checksum: targetChecksum,
    listingCount: listings.length
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    console.log(JSON.stringify(generateInitialArtifact(parseArgs(process.argv.slice(2))), null, 2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

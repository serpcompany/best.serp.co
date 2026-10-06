/**
 * Listing FAQs move from the long description to the FAQs section (serpcompany/best.serp.co#105,
 * owner decision on 2026-10-06). Read-only and repeatable.
 *
 *   pnpm catalog:faqs                print what the manifest would change
 *   pnpm catalog:faqs -- manifest    write d1/publications/2026-10-06-listing-faqs.yaml
 *
 * The one-time import stored every imported FAQ twice: in `listing_faqs` (which the listing
 * page's FAQs section shows) and as a `## FAQ` block at the end of the long description. The
 * manifest removes that block, and only that block: one `listing-content-remove-suffix`
 * operation per listing, each guarded by the description's length and its exact ending, so every
 * other character stays as it is and a description edited since is refused.
 *
 * Listings come from the reviewed import (`d1/artifacts`), the catalog both environments were
 * bootstrapped from. By default the manifest follows #100's (`2026-10-06-hijacked-domains.yaml`):
 * its base is the publication state that one leaves. For an environment that has moved on, pass
 * its current state (--base-version N --base-checksum <sha256>, read with
 * `pnpm tsx scripts/cloudflare-release.ts check-database <env>`) and a new --manifest-id, which
 * names the output file (d1/publications/<id>.yaml); --skip <slug>[,<slug>] (repeatable) leaves
 * out listings whose description changed there.
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { Document, isPair, isScalar, Scalar, visit } from 'yaml'
import { freshMigrationNames, freshMigrationsDirectory } from './d1-drizzle-local'
import { readParityReport, readReviewedImportSql } from './d1-import-artifact'
import { buildPublicationPlan, parseManifest } from './d1-publisher'

export const FAQ_MANIFEST_ID = '2026-10-06-listing-faqs'
export const FAQ_MANIFEST_PATH = manifestPath(FAQ_MANIFEST_ID)
/** The manifest this one follows (#100), whose resulting state is its default base. */
export const PREVIOUS_MANIFEST_PATH = 'd1/publications/2026-10-06-hijacked-domains.yaml'
export const FAQ_MOVE_REASON = '#105 FAQs move from the description to the FAQs section'

export interface FaqListing {
  content: string
  faqs: Array<{ answer: string; question: string }>
  id: string
  slug: string
}

/** Listings of the reviewed import that have FAQs, with their description and FAQs in order. */
export function reviewedImportFaqListings(): FaqListing[] {
  const database = new DatabaseSync(':memory:')
  try {
    for (const migration of freshMigrationNames()) {
      database.exec(readFileSync(resolve(freshMigrationsDirectory, migration), 'utf8'))
    }
    database.exec(readReviewedImportSql(readParityReport()))
    const rows = database
      .prepare(
        `SELECT l.id,l.slug,COALESCE(l.content,'') AS content,
          (SELECT json_group_array(json_object('question',question,'answer',answer)) FROM
            (SELECT question,answer FROM listing_faqs f WHERE f.listing_id=l.id
              ORDER BY f.sort_order)) AS faqs
        FROM listings l WHERE EXISTS (SELECT 1 FROM listing_faqs f WHERE f.listing_id=l.id)
        ORDER BY l.slug`
      )
      .all() as Array<Record<string, string>>
    return rows.map(row => ({
      content: row.content ?? '',
      faqs: JSON.parse(row.faqs ?? '[]') as FaqListing['faqs'],
      id: row.id ?? '',
      slug: row.slug ?? ''
    }))
  } finally {
    database.close()
  }
}

/** The import's MDX escaping of FAQ text (`scripts/migration/generate-initial-artifact.ts`). */
function escapeMdx(value: string): string {
  return value.replaceAll('{', '\\{').replaceAll('}', '\\}')
}
const FAQ_HEADING = /^## FAQ$/gmu

/**
 * The exact text to remove from a listing's description: the blank line before its `## FAQ`
 * heading and the block to the end. Refused unless the block is the description's last section
 * and is exactly what the import wrote for the listing's FAQs, in order (`### <question>`, a
 * blank line, the answer, with its MDX brace escapes), so nothing but the FAQs ever leaves a
 * description.
 */
export function faqBlockSuffix(listing: FaqListing): string {
  const headings = [...listing.content.matchAll(FAQ_HEADING)]
  if (headings.length !== 1) {
    throw new Error(`${listing.slug}: expected one "## FAQ" heading, found ${headings.length}.`)
  }
  const start = headings[0]?.index ?? -1
  if (listing.content.slice(start - 2, start) !== '\n\n') {
    throw new Error(`${listing.slug}: the FAQ block doesn't follow a blank line.`)
  }
  const block = listing.content.slice(start)
  if (/^## /mu.test(block.slice('## FAQ'.length))) {
    throw new Error(`${listing.slug}: the FAQ block isn't the description's last section.`)
  }
  const expected = `## FAQ\n\n${listing.faqs
    .map(faq => `### ${escapeMdx(faq.question)}\n\n${escapeMdx(faq.answer)}`)
    .join('\n\n')}`
  if (block !== expected) {
    throw new Error(`${listing.slug}: the FAQ block doesn't match the listing's FAQs.`)
  }
  return `\n\n${block}`
}

/** The publication state a committed manifest leaves: its version + 1 and after-checksum. */
export function stateAfter(manifestPath: string): { checksum: string; version: number } {
  const source = readFileSync(resolve(manifestPath), 'utf8')
  const manifest = parseManifest(source)
  const plan = buildPublicationPlan(manifest, source, new Date(0).toISOString())
  return { checksum: plan.afterChecksum, version: manifest.basePublicationVersion + 1 }
}

export interface FaqManifestOptions {
  baseChecksum: string
  baseVersion: number
  id: string
  /**
   * Why the base is what it is, for the header. Omitted: it is the state #100's manifest leaves
   * (the default); set when `--base-version` and `--base-checksum` override it.
   */
  baseOverride?: boolean
  /** Slugs left out because their description drifted on the target environment. */
  skip?: readonly string[]
}

/** Where a manifest with this id is written: one reviewed file per id. */
export function manifestPath(id: string): string {
  return `d1/publications/${id}.yaml`
}

export function buildFaqMoveManifest(
  listings: readonly FaqListing[],
  options: FaqManifestOptions
): string {
  const skip = new Set(options.skip ?? [])
  const unknown = [...skip].filter(slug => !listings.some(listing => listing.slug === slug))
  if (unknown.length > 0)
    throw new Error(`--skip names no listing with FAQs: ${unknown.join(', ')}.`)
  const kept = listings.filter(listing => !skip.has(listing.slug))
  const operations = kept.map(listing => ({
    action: 'listing-content-remove-suffix',
    id: listing.id,
    slug: listing.slug,
    reason: FAQ_MOVE_REASON,
    expected: { contentLength: [...listing.content].length },
    suffix: faqBlockSuffix(listing)
  }))
  if (operations.length === 0) throw new Error('No listing has FAQs to move.')
  const faqCount = kept.reduce((total, listing) => total + listing.faqs.length, 0)
  const manifest = {
    version: 1,
    id: options.id,
    basePublicationVersion: options.baseVersion,
    provenance: {
      actor: 'devinschumacher',
      workflow: 'github/publish-d1',
      beforeChecksum: options.baseChecksum
    },
    operations
  }
  const header = `# serpcompany/best.serp.co#105: move ${faqCount} imported FAQs on ${operations.length} listings from the long description to
# the listing page's FAQs section, as the owner decided on 2026-10-06. Each operation removes only
# the description's closing "## FAQ" block (the FAQs stay in listing_faqs, which the section shows)
# and refuses a description whose length or ending changed since.
# Generated by \`pnpm catalog:faqs -- manifest\` from the reviewed import. ${
    options.baseOverride
      ? `Its base was set by hand to
# publication version ${options.baseVersion} (checksum ${options.baseChecksum.slice(0, 12)}…), an environment's state when it was
# generated; publish it there before #98's.`
      : `Its base is the state #100's
# manifest (2026-10-06-hijacked-domains.yaml) leaves: publish that one first, then this, then #98's.`
  }${
    skip.size > 0
      ? `
# Left out (their description drifted there): ${[...skip].sort().join(', ')}.`
      : ''
  }
# Apply staging first, then production after promotion.
`
  // Each suffix as one double-quoted string: a block scalar would need a whitespace-only line for
  // its leading blank line, which an editor or formatter could strip.
  const document = new Document(manifest)
  visit(document, {
    Pair(_key, pair) {
      if (
        isPair(pair) &&
        isScalar(pair.key) &&
        pair.key.value === 'suffix' &&
        isScalar(pair.value)
      ) {
        pair.value.type = Scalar.QUOTE_DOUBLE
      }
    }
  })
  const source = `${header}${document.toString({ lineWidth: 0 })}`
  // Refuse to write a manifest the publisher would not accept.
  buildPublicationPlan(parseManifest(source), source, new Date().toISOString())
  return source
}

function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}

function options(argv: readonly string[], name: string): string[] {
  return argv.flatMap((value, index) =>
    value === name && argv[index + 1] ? (argv[index + 1] ?? '').split(',') : []
  )
}

function main(): void {
  const argv = process.argv.slice(2).filter(value => value !== '--')
  const listings = reviewedImportFaqListings()
  const previous = stateAfter(PREVIOUS_MANIFEST_PATH)
  const versionOption = option(argv, '--base-version')
  const checksumOption = option(argv, '--base-checksum')
  if ((versionOption === undefined) !== (checksumOption === undefined)) {
    throw new Error('Pass --base-version and --base-checksum together.')
  }
  const baseVersion = Number(versionOption ?? previous.version)
  const baseChecksum = checksumOption ?? previous.checksum
  if (!Number.isSafeInteger(baseVersion) || baseVersion < 0) {
    throw new Error('--base-version must be a non-negative integer.')
  }
  if (!/^[a-f0-9]{64}$/u.test(baseChecksum)) throw new Error('--base-checksum must be a sha256.')
  const id = option(argv, '--manifest-id') ?? FAQ_MANIFEST_ID
  const baseOverride = versionOption !== undefined
  if (baseOverride && id === FAQ_MANIFEST_ID) {
    throw new Error(
      'A manifest with another base needs its own --manifest-id, so the reviewed one is kept.'
    )
  }
  const skip = options(argv, '--skip')
  const source = buildFaqMoveManifest(listings, {
    baseChecksum,
    baseOverride,
    baseVersion,
    id,
    skip
  })
  const kept = listings.filter(listing => !skip.includes(listing.slug))
  const faqs = kept.reduce((total, listing) => total + listing.faqs.length, 0)
  if (argv[0] === 'manifest') {
    const path = manifestPath(id)
    writeFileSync(resolve(path), source)
    console.log(
      `Wrote ${path}: ${kept.length} listings, ${faqs} FAQs, base version ${baseVersion}, sha256 ${createHash('sha256').update(source).digest('hex').slice(0, 12)}.`
    )
    return
  }
  console.log(`${kept.length} listings, ${faqs} FAQs; run with "manifest" to write it.`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main()
}

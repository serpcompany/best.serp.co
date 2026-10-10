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
 * bootstrapped from. The manifest is row-level (`concurrency: rows`): it names no base version,
 * so it publishes whatever else each environment published before it (#100's and #98's
 * manifests included), and each listing is guarded by its own description instead. If an
 * environment edited some of these descriptions, the whole manifest is refused; regenerate with
 * --skip <slug>[,<slug>] (repeatable) and a new --manifest-id, which names the output file
 * (d1/publications/<id>.yaml).
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

export interface FaqManifestOptions {
  id: string
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
    concurrency: 'rows',
    provenance: { actor: 'devinschumacher', workflow: 'github/publish-d1' },
    operations
  }
  const header = `# serpcompany/best.serp.co#105: move ${faqCount} imported FAQs on ${operations.length} listings from the long description to
# the listing page's FAQs section, as the owner decided on 2026-10-06. Each operation removes only
# the description's closing "## FAQ" block (the FAQs stay in listing_faqs, which the section shows)
# and refuses a description whose length or ending changed since.
# Generated by \`pnpm catalog:faqs -- manifest\` from the reviewed import. Row-level: it names no
# base version, so it publishes in any order relative to #100's and #98's manifests.${
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
  buildPublicationPlan(parseManifest(source), source, new Date().toISOString(), {
    checksum: '0'.repeat(64),
    version: 0
  })
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
  const id = option(argv, '--manifest-id') ?? FAQ_MANIFEST_ID
  const skip = options(argv, '--skip')
  if (skip.length > 0 && id === FAQ_MANIFEST_ID) {
    throw new Error(
      'A manifest that skips listings needs its own --manifest-id, so the reviewed one is kept.'
    )
  }
  const source = buildFaqMoveManifest(listings, { id, skip })
  const kept = listings.filter(listing => !skip.includes(listing.slug))
  const faqs = kept.reduce((total, listing) => total + listing.faqs.length, 0)
  if (argv[0] === 'manifest') {
    const path = manifestPath(id)
    writeFileSync(resolve(path), source)
    console.log(
      `Wrote ${path}: ${kept.length} listings, ${faqs} FAQs, sha256 ${createHash('sha256').update(source).digest('hex').slice(0, 12)}.`
    )
    return
  }
  console.log(`${kept.length} listings, ${faqs} FAQs; run with "manifest" to write it.`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main()
}

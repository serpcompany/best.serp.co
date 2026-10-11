/**
 * The resource links of SERP's downloader listings that no longer work (serpcompany/best.serp.co#376).
 *
 *   pnpm catalog:downloader-links
 *       write d1/publications/2026-10-11-downloader-links.yaml from the checks recorded in
 *       d1/hygiene/2026-10-11-downloader-links.yaml
 *
 * The hygiene file records every github.com/serpapps, Product Hunt, and Chrome Web Store link on a
 * live listing with its status on 2026-10-11 and a verdict, and every live listing that carries one
 * with all of its links in order. Each listing with a link that isn't `ok` gets one
 * `listing-resources-set`, taking #376's recorded defaults:
 * - `dead` (404): removed, unless the check names a live `replacement`, which takes its place (the
 *   live repositories of twitter-x-downloader and mindvalley-downloader);
 * - `renamed` (a store item that 301s to a new URL): the item's final URL, in place;
 * - `removed` (a store item that now redirects to the store's generic page): removed.
 * Every other link stays, with its label, in its order. A listing #337's
 * `2026-10-10-duplicate-listings` retires is left alone, as #376 says of whop-downloader: once that
 * manifest and its slug redirects are published, its page answers 308 and shows no links.
 *
 * The manifest is row-level (`concurrency: rows`): each operation expects the listing's links as the
 * hygiene file lists them and refuses its whole batch if they changed since, so one file applies on
 * staging and production alike. It reads only committed files: no D1, and nothing from `.archive/`.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse, stringify } from 'yaml'
import { buildPublicationPlan, parseManifest } from './d1-publisher'

export const downloaderLinksPaths = {
  checks: 'd1/hygiene/2026-10-11-downloader-links.yaml',
  /** #337's retirements, which this manifest leaves alone. */
  duplicates: 'd1/publications/2026-10-10-duplicate-listings.yaml'
}
export const DOWNLOADER_LINKS_MANIFEST_ID = '2026-10-11-downloader-links'

export const linkVerdicts = ['ok', 'dead', 'renamed', 'removed'] as const
export type LinkVerdict = (typeof linkVerdicts)[number]

/** Where a checked URL's redirects ended. */
export interface LinkResponse {
  status: number
  url: string
  title?: string
}

/** One checked URL of the hygiene file. */
export interface CheckedLink {
  url: string
  /** The first response, redirects not followed. */
  status: number
  final?: LinkResponse
  title?: string
  /** `gh api repos/serpapps/<name>` as an org member: 404 means the repository is gone. */
  githubApi?: number
  verdict: LinkVerdict
  /** The live link a dead one moves to. */
  replacement?: { url: string; status: number; final?: LinkResponse; githubApi?: number }
}

export interface ResourceLink {
  label: string
  url: string
}

/** A live listing of the hygiene file, with all of its links in order. */
export interface ListingLinks {
  id: string
  slug: string
  links: ResourceLink[]
}

/** The links the check covers: every other link on a listing stays as it is. */
export const CHECKED_LINK =
  /^https:\/\/(?:github\.com\/serpapps\/|www\.producthunt\.com\/|chromewebstore\.google\.com\/)/u
const STORE_ITEM = /^https:\/\/chromewebstore\.google\.com\/detail\/[^/]+\/([a-p]{32})$/u
const REMOVED_ITEM = /^https:\/\/chromewebstore\.google\.com\/detail\/empty-title\/([a-p]{32})$/u
const LATEST_RELEASE = /^https:\/\/github\.com\/(serpapps\/[^/]+)\/releases\/latest$/u

/** Where a link ends up after its redirects: its own URL and status when it has none. */
const landing = (link: { status: number; url: string; final?: LinkResponse }): LinkResponse =>
  link.final ?? { status: link.status, url: link.url }

/**
 * A GitHub `/releases/latest` link answers 302 to the latest release's tag, by design: `ok` when
 * that tag answers 200.
 */
function releaseRedirect(link: { status: number; url: string; final?: LinkResponse }): boolean {
  const repository = LATEST_RELEASE.exec(link.url)?.[1]
  return (
    repository !== undefined &&
    link.status === 302 &&
    link.final?.status === 200 &&
    link.final.url.startsWith(`https://github.com/${repository}/releases/tag/`)
  )
}

/** A live response: 200, or a release link's redirect to its tag; a repository the API finds. */
function answers(link: {
  status: number
  url: string
  final?: LinkResponse
  githubApi?: number
}): boolean {
  if (link.url.startsWith('https://github.com/') && link.githubApi !== 200) return false
  return (link.status === 200 && link.final === undefined) || releaseRedirect(link)
}

/** Refuses a verdict its recorded responses don't support. */
export function checkVerdict(link: CheckedLink): void {
  const fail = (why: string) => {
    throw new Error(`${link.url}: ${link.verdict} ${why}.`)
  }
  if (!CHECKED_LINK.test(link.url)) fail('is not a link the check covers')
  if (link.url.startsWith('https://github.com/') && link.githubApi === undefined)
    fail('needs githubApi')
  if (link.replacement && link.verdict !== 'dead')
    fail('has a replacement, but only a dead link moves')
  const end = landing(link)
  const item = STORE_ITEM.exec(link.url)?.[1]
  switch (link.verdict) {
    case 'ok':
      if (!answers(link)) fail('does not answer 200')
      return
    case 'dead':
      if (link.status !== 404 || link.final !== undefined) fail('does not answer 404')
      if (link.url.startsWith('https://github.com/') && link.githubApi !== 404)
        fail('has a repository the API finds')
      if (link.replacement) {
        if (!CHECKED_LINK.test(link.replacement.url) || !answers(link.replacement))
          fail('moves to a link that does not answer 200')
      }
      return
    case 'renamed':
      if (
        item === undefined ||
        link.status !== 301 ||
        end.status !== 200 ||
        end.url === link.url ||
        REMOVED_ITEM.test(end.url) ||
        STORE_ITEM.exec(end.url)?.[1] !== item
      )
        fail('is not a store item that 301s to a new URL with the same item id, answering 200')
      return
    case 'removed':
      if (item === undefined || REMOVED_ITEM.exec(end.url)?.[1] !== item)
        fail("is not a store item that redirects to the store's generic page")
      return
    default:
      fail('is not a verdict')
  }
}

/** The listings a committed manifest unpublishes, by id (its slug). */
export function committedRetirements(path = downloaderLinksPaths.duplicates): Map<string, string> {
  const manifest = parse(readFileSync(resolve(path), 'utf8')) as {
    operations?: Array<{ action?: string; id?: string; slug?: string }>
  }
  return new Map(
    (manifest.operations ?? []).flatMap(operation =>
      operation.action === 'listing-unpublish' && operation.id && operation.slug
        ? [[operation.id, operation.slug] as const]
        : []
    )
  )
}

/** The activity log's reason for each kind of change, in the order a reason lists them. */
const CHANGE_REASONS = {
  github: 'removes a link to a deleted GitHub repository',
  productHunt: 'removes a Product Hunt link that answers 404',
  removedItem: 'removes a Chrome Web Store link to a removed item',
  renamedItem: 'points a Chrome Web Store link at its renamed URL',
  replacement: 'points a GitHub link at the live repository'
} as const
type Change = keyof typeof CHANGE_REASONS

function changeOf(link: CheckedLink): Change | null {
  if (link.verdict === 'ok') return null
  if (link.verdict === 'renamed') return 'renamedItem'
  if (link.verdict === 'removed') return 'removedItem'
  if (link.replacement) return 'replacement'
  return link.url.startsWith('https://github.com/') ? 'github' : 'productHunt'
}

/**
 * The `listing-resources-set` operations, in slug order, and the listings left alone because #337
 * retires them (`retired`) though a link of theirs would change. Refuses a check twice, a verdict
 * its responses don't support, a listing twice, a covered link no check names, and a check no
 * listing carries.
 */
export function downloaderLinkOperations(
  checks: readonly CheckedLink[],
  listings: readonly ListingLinks[],
  retired: ReadonlyMap<string, string> = new Map()
): { operations: Array<Record<string, unknown>>; leftAlone: string[] } {
  const byUrl = new Map<string, CheckedLink>()
  for (const check of checks) {
    if (byUrl.has(check.url)) throw new Error(`${check.url} is checked twice.`)
    checkVerdict(check)
    byUrl.set(check.url, check)
  }
  const used = new Set<string>()
  const seen = new Set<string>()
  const operations: Array<Record<string, unknown>> = []
  const leftAlone: string[] = []
  // Code-point order, the same on every machine (localeCompare depends on the locale).
  for (const listing of [...listings].sort((a, b) =>
    a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0
  )) {
    if (seen.has(listing.id) || seen.has(listing.slug))
      throw new Error(`${listing.slug} is listed twice.`)
    seen.add(listing.id).add(listing.slug)
    const changes = new Set<Change>()
    const resources: ResourceLink[] = []
    for (const link of listing.links) {
      if (!CHECKED_LINK.test(link.url)) {
        resources.push(link)
        continue
      }
      const check = byUrl.get(link.url)
      if (!check) throw new Error(`${listing.slug}: no check names ${link.url}.`)
      used.add(link.url)
      const change = changeOf(check)
      if (change) changes.add(change)
      if (check.verdict === 'ok') resources.push(link)
      else if (check.verdict === 'renamed')
        resources.push({ label: link.label, url: landing(check).url })
      else if (check.replacement) resources.push({ label: link.label, url: check.replacement.url })
    }
    if (changes.size === 0) continue
    if (retired.has(listing.id)) {
      if (retired.get(listing.id) !== listing.slug)
        throw new Error(`${listing.slug} is retired under another slug.`)
      leftAlone.push(listing.slug)
      continue
    }
    const kinds = (Object.keys(CHANGE_REASONS) as Change[]).filter(kind => changes.has(kind))
    operations.push({
      action: 'listing-resources-set',
      id: listing.id,
      slug: listing.slug,
      reason: `#376: ${kinds.map(kind => CHANGE_REASONS[kind]).join(', ')}; evidence in ${downloaderLinksPaths.checks}`,
      expected: listing.links,
      resources
    })
  }
  const unused = checks.filter(check => !used.has(check.url)).map(check => check.url)
  if (unused.length > 0) throw new Error(`No listing carries ${unused.join(', ')}.`)
  return { operations, leftAlone }
}

/** The manifest's source, which the publisher accepts (planned at any publication state). */
export function buildDownloaderLinksManifest(
  checks: readonly CheckedLink[],
  listings: readonly ListingLinks[],
  retired: ReadonlyMap<string, string> = new Map()
): string {
  const { operations, leftAlone } = downloaderLinkOperations(checks, listings, retired)
  const manifest = {
    version: 1,
    id: DOWNLOADER_LINKS_MANIFEST_ID,
    concurrency: 'rows',
    provenance: { actor: 'devinschumacher', workflow: 'github/publish-d1' },
    operations
  }
  const source = `# serpcompany/best.serp.co#376: fix the "Links" section of ${operations.length} live listings with a
# github.com/serpapps, Product Hunt, or Chrome Web Store link that no longer works, as checked on
# 2026-10-11 (${downloaderLinksPaths.checks}), taking #376's recorded defaults:
# - a link to a deleted repository, or to a Product Hunt page that answers 404, is removed. If the
#   owner restores a repository, a later manifest can add its link again;
# - twitter-x-downloader's and mindvalley-downloader's dead GitHub links point at their live
#   repositories (serpapps/twitter-x-downloader, serpapps/mindvalley-downloader);
# - a Chrome Web Store link to a renamed item takes the item's final URL, in place; one to a removed
#   item is removed.
# Every other link stays, with its label, in its order.
# Left alone: the listings 2026-10-10-duplicate-listings (#337) retires, as #376 says of
# whop-downloader: ${leftAlone.join(', ')} would change.
# Each listing-resources-set compares and swaps the listing's slug and every link in order, refuses
# a listing that isn't approved or whose own submission is in review or was rejected, gives it a new
# checksum and lastmod, and logs "Details edited: links".
# Generated by \`pnpm catalog:downloader-links\` from the checks. Row-level: a listing whose links
# changed since refuses the whole batch, with nothing written. It applies before or after the other
# committed manifests. Publish on staging first, then on production after promotion.
${stringify(manifest, { aliasDuplicateObjects: false, lineWidth: 0 })}`
  buildPublicationPlan(parseManifest(source), source, new Date().toISOString(), {
    checksum: 'a'.repeat(64),
    version: 1
  })
  return source
}

/** The committed inputs: the checks, the live listings, and #337's retirements. */
export function readDownloaderLinksInputs(paths = downloaderLinksPaths): {
  checks: CheckedLink[]
  listings: ListingLinks[]
  retired: Map<string, string>
} {
  const file = parse(readFileSync(resolve(paths.checks), 'utf8')) as {
    links?: CheckedLink[]
    listings?: ListingLinks[]
  }
  if (!file.links || !file.listings) throw new Error(`${paths.checks} has no links or listings.`)
  return {
    checks: file.links,
    listings: file.listings,
    retired: committedRetirements(paths.duplicates)
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const { checks, listings, retired } = readDownloaderLinksInputs()
  const path = resolve('d1/publications', `${DOWNLOADER_LINKS_MANIFEST_ID}.yaml`)
  writeFileSync(path, buildDownloaderLinksManifest(checks, listings, retired))
  console.log(`Wrote d1/publications/${DOWNLOADER_LINKS_MANIFEST_ID}.yaml`)
}

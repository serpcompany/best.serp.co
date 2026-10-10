import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { project } from '../project'
import { categoryRoute, listingRoute } from '../site-routes'

/**
 * Structural parity check between the legacy static site and a D1-backed
 * deployment: fetches the same paths from both origins and compares the
 * SEO-relevant shape of each page (status, title, h1, canonical path,
 * meta description, JSON-LD types, FAQ count).
 *
 * The baseline is the legacy static site, which used /products/<slug>/reviews/ and
 * /products/best/<category>/; those paths are translated to the current routes before
 * fetching the candidate and before comparing canonical paths. Since the cutover (#50),
 * best.serp.co is itself the D1 Worker and redirects those paths permanently, so a baseline
 * that answers a legacy path with 301/308 must redirect to exactly the translated route, and is
 * then compared at that route. Outbound link `rel` values are compared too (#62).
 *
 * Usage: pnpm tsx scripts/migration/compare-pages.ts <candidate-origin> [--baseline <origin>] [--sample 25]
 */

export function translateLegacyPath(path: string): string {
  const detail = /^\/products\/([^/]+)\/reviews\/?$/u.exec(path)
  if (detail?.[1]) return listingRoute(detail[1])
  const category = /^\/products\/best\/([^/]+)\/?$/u.exec(path)
  if (category?.[1]) return categoryRoute(category[1])
  return path
}

interface PageShape {
  canonicalPath: string | null
  description: string | null
  faqCount: number
  h1: string | null
  jsonLdTypes: string[]
  /** `rel` of every link to another site, sorted: covers the listing's outbound link (#62). */
  outboundRels: string[]
  status: number
  title: string | null
}

interface FetchedPage {
  /** The `Location` of a redirect, resolved against the request URL. */
  location: string | null
  shape: PageShape
}

function decode(value: string): string {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&#x27;', "'")
    .replaceAll('&#39;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replace(/\s+/gu, ' ')
    .trim()
}

function firstMatch(html: string, pattern: RegExp): string | null {
  const match = pattern.exec(html)
  return match?.[1] ? decode(match[1].replace(/<[^>]+>/gu, '')) : null
}

function jsonLdTypes(html: string): string[] {
  const types = new Set<string>()
  for (const match of html.matchAll(
    /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gu
  )) {
    for (const type of match[1]?.matchAll(/"@type"\s*:\s*"([^"]+)"/gu) ?? []) {
      if (type[1]) types.add(type[1])
    }
  }
  return [...types].sort()
}

/** The `rel` of every `<a>` that links to another site (not the page's origin or best.serp.co). */
export function outboundRels(html: string, origin: string): string[] {
  const ownHosts = new Set([new URL(origin).host, new URL(project.publicUrl).host])
  const rels: string[] = []
  for (const tag of html.matchAll(/<a\b[^>]*>/gu)) {
    const href = /\shref="([^"]+)"/u.exec(tag[0])?.[1]
    if (!href || !/^https?:\/\//u.test(href)) continue
    let host: string
    try {
      host = new URL(decode(href)).host
    } catch {
      continue
    }
    if (ownHosts.has(host)) continue
    rels.push(/\srel="([^"]*)"/u.exec(tag[0])?.[1] ?? '(none)')
  }
  return rels.sort()
}

async function fetchShape(origin: string, path: string): Promise<FetchedPage> {
  const url = new URL(path, origin)
  const response = await fetch(url, { redirect: 'manual' })
  const html = response.status === 200 ? await response.text() : ''
  const canonical = firstMatch(html, /<link[^>]*rel="canonical"[^>]*href="([^"]+)"/u)
  const location = response.headers.get('location')
  return {
    location: location ? new URL(location, url).toString() : null,
    shape: {
      canonicalPath: canonical ? new URL(canonical).pathname : null,
      description: firstMatch(html, /<meta[^>]*name="description"[^>]*content="([^"]*)"/u),
      faqCount: (html.match(/"@type"\s*:\s*"Question"/gu) ?? []).length,
      h1: firstMatch(html, /<h1[^>]*>([\s\S]*?)<\/h1>/u),
      jsonLdTypes: jsonLdTypes(html),
      outboundRels: outboundRels(html, origin),
      status: response.status,
      title: firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/u)
    }
  }
}

/**
 * Since the cutover the baseline is itself the D1 Worker and redirects legacy paths. Such a
 * redirect must point at exactly the translated route on the baseline's own origin.
 */
export function redirectsToTranslated(
  location: string | null,
  baseline: string,
  translated: string
) {
  if (!location) return false
  const target = new URL(location)
  return (
    target.origin === new URL(baseline).origin &&
    `${target.pathname}${target.search}` === translated
  )
}

function samplePaths(sampleSize: number): string[] {
  const report = parse(readFileSync(resolve(project.artifact.parityReportPath), 'utf8')) as {
    parity: { categories: Array<{ slug: string }>; exactSlugSet: string[] }
  }
  const pick = <T>(values: T[], count: number): T[] => {
    const step = Math.max(1, Math.floor(values.length / count))
    return values.filter((_, index) => index % step === 0).slice(0, count)
  }
  return [
    '/',
    '/products/',
    '/brands/',
    '/about/',
    '/submit/',
    '/legal/privacy-policy/',
    ...pick(report.parity.categories, 5).map(category => `/products/best/${category.slug}/`),
    ...pick(report.parity.exactSlugSet, sampleSize).map(slug => `/products/${slug}/reviews/`)
  ]
}

function parseArgs(args: string[]): { baseline: string; candidate: string; sample: number } {
  const values = args.filter(value => value !== '--')
  const valueFor = (flag: string): string | undefined => {
    const index = values.indexOf(flag)
    return index < 0 ? undefined : values[index + 1]
  }
  const candidate = values.find(
    value => /^https?:\/\//u.test(value) && values[values.indexOf(value) - 1] !== '--baseline'
  )
  if (!candidate) {
    throw new Error(
      'Usage: pnpm tsx scripts/migration/compare-pages.ts <candidate-origin> [--baseline <origin>] [--sample 25]'
    )
  }
  return {
    baseline: valueFor('--baseline') ?? project.publicUrl,
    candidate,
    sample: Number(valueFor('--sample') ?? 25)
  }
}

export async function comparePages(options: {
  baseline: string
  candidate: string
  sample: number
}): Promise<number> {
  let differences = 0
  for (const path of samplePaths(options.sample)) {
    const translated = translateLegacyPath(path)
    const [fetchedLegacy, fetchedCandidate] = await Promise.all([
      fetchShape(options.baseline, path),
      fetchShape(options.candidate, translated)
    ])
    let legacy = fetchedLegacy.shape
    const candidate = fetchedCandidate.shape
    const problems: string[] = []
    if (translated !== path && (legacy.status === 301 || legacy.status === 308)) {
      if (!redirectsToTranslated(fetchedLegacy.location, options.baseline, translated)) {
        problems.push(
          `      location: ${JSON.stringify(fetchedLegacy.location)} -> expected ${JSON.stringify(translated)}`
        )
      }
      legacy = (await fetchShape(options.baseline, translated)).shape
    }
    const baseline = {
      ...legacy,
      canonicalPath: legacy.canonicalPath && translateLegacyPath(legacy.canonicalPath)
    }
    const fields = (Object.keys(baseline) as Array<keyof PageShape>).filter(
      field => JSON.stringify(baseline[field]) !== JSON.stringify(candidate[field])
    )
    if (fields.length === 0 && problems.length === 0) {
      console.log(`ok    ${path}`)
      continue
    }
    differences += 1
    console.log(`DIFF  ${path}`)
    for (const problem of problems) console.log(problem)
    for (const field of fields) {
      console.log(
        `      ${field}: ${JSON.stringify(baseline[field])} -> ${JSON.stringify(candidate[field])}`
      )
    }
  }
  return differences
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  comparePages(parseArgs(process.argv.slice(2)))
    .then(differences => {
      console.log(`\n${differences} page(s) differ.`)
      if (differences > 0) process.exitCode = 1
    })
    .catch(error => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    })
}

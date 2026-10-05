/**
 * Pure readers for the crawl policy a deployment serves: `X-Robots-Tag`, `<meta name="robots">`
 * and robots.txt. The HTTP gates use them to prove that Staging stays out of search indexes and
 * that Production can be crawled and indexed (serp standards/environment-configuration.md).
 * They answer only for Google and for every crawler (`*`); rules aimed at other bots are ignored.
 */

const INDEXING_AGENTS = new Set(['*', 'googlebot'])
const BLOCKING_DIRECTIVES = new Set(['noindex', 'none'])
// Directives whose value follows a colon, so `max-image-preview: none` is not a bot prefix.
const VALUED_DIRECTIVES = new Set([
  'max-image-preview',
  'max-snippet',
  'max-video-preview',
  'unavailable_after'
])

function blocksWithDirectives(directives: Iterable<string>): boolean {
  for (const directive of directives)
    if (BLOCKING_DIRECTIVES.has(directive.trim().toLowerCase())) return true
  return false
}

/**
 * True when an `X-Robots-Tag` value tells Google (or every crawler) not to index the page:
 * a whole `noindex` or `none` directive, unscoped or scoped to `googlebot`. A `bingbot: noindex`
 * value or `max-image-preview: none` does not count. Joined header values keep the most recent
 * bot prefix, as Google reads them.
 */
export function xRobotsTagBlocksIndexing(value: string | null): boolean {
  if (!value) return false
  let agent = '*'
  for (const part of value.split(',')) {
    let directive = part.trim().toLowerCase()
    const colon = directive.indexOf(':')
    if (colon > 0) {
      const prefix = directive.slice(0, colon).trim()
      if (!VALUED_DIRECTIVES.has(prefix) && /^[a-z0-9_*-]+$/u.test(prefix)) {
        agent = prefix
        directive = directive.slice(colon + 1).trim()
      }
    }
    if (INDEXING_AGENTS.has(agent) && blocksWithDirectives([directive])) return true
  }
  return false
}

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'iu').exec(
    tag
  )
  return match ? (match[1] ?? match[2] ?? match[3] ?? '') : null
}

/** True when the document's `<meta name="robots|googlebot">` tells Google not to index it. */
export function metaRobotsBlocksIndexing(html: string): boolean {
  const head = html.split(/<\/head>/iu)[0] ?? html
  for (const [tag] of head.matchAll(/<meta\b[^>]*>/giu)) {
    const name = attribute(tag, 'name')?.trim().toLowerCase()
    if (name !== 'robots' && name !== 'googlebot') continue
    if (blocksWithDirectives((attribute(tag, 'content') ?? '').split(','))) return true
  }
  return false
}

interface RobotsRule {
  allow: boolean
  pattern: string
}

interface RobotsGroup {
  agents: string[]
  rules: RobotsRule[]
}

/** Groups of robots.txt (RFC 9309): consecutive `User-agent` lines followed by their rules. */
export function parseRobotsTxt(text: string): RobotsGroup[] {
  const groups: RobotsGroup[] = []
  let current: RobotsGroup | undefined
  let collectingAgents = false
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.replace(/#.*$/u, '').trim()
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const field = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()
    if (field === 'user-agent') {
      if (!current || !collectingAgents) {
        current = { agents: [], rules: [] }
        groups.push(current)
      }
      current.agents.push(value.toLowerCase())
      collectingAgents = true
    } else if (field === 'allow' || field === 'disallow') {
      collectingAgents = false
      // An empty Disallow allows everything; an empty Allow says nothing.
      if (current && value) current.rules.push({ allow: field === 'allow', pattern: value })
    }
  }
  return groups
}

function ruleMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$')
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split('*')
    .map(part => part.replace(/[.+?^${}()|[\]\\]/gu, '\\$&'))
    .join('.*')
  return new RegExp(`^${body}${anchored ? '$' : ''}`, 'u').test(path)
}

/** Whether `agent` may fetch `path`: the longest matching rule wins, and Allow wins a tie. */
export function robotsTxtAllows(groups: RobotsGroup[], agent: string, path: string): boolean {
  const named = groups.filter(group => group.agents.includes(agent))
  const applicable = named.length > 0 ? named : groups.filter(group => group.agents.includes('*'))
  let verdict: RobotsRule | undefined
  for (const rule of applicable.flatMap(group => group.rules)) {
    if (!ruleMatches(rule.pattern, path)) continue
    if (
      !verdict ||
      rule.pattern.length > verdict.pattern.length ||
      (rule.pattern.length === verdict.pattern.length && rule.allow)
    )
      verdict = rule
  }
  return verdict?.allow ?? true
}

/**
 * The first `{agent, path}` that robots.txt keeps Google or every crawler from fetching, or
 * null when all of `paths` are crawlable for both. Groups for other bots are ignored.
 */
export function robotsTxtBlockedPath(
  text: string,
  paths: readonly string[]
): { agent: string; path: string } | null {
  const groups = parseRobotsTxt(text)
  for (const agent of INDEXING_AGENTS)
    for (const path of paths) if (!robotsTxtAllows(groups, agent, path)) return { agent, path }
  return null
}

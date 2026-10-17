import { siteConfig } from '../site/site-config'

/**
 * Page titles (#521): what each page puts before the root layout's ` | SERP Best`, and the
 * sentence its meta description leads with. Search results show about 60 characters of a title,
 * so a long name steps down to a shorter pattern instead of being cut: a name is never cut and the
 * suffix is always kept, even when the shortest pattern still runs over.
 */

/** About how many characters of a title search results show. */
export const TITLE_MAX_LENGTH = 60

/** The root layout's title template appends this to every title but the homepage's. */
export const TITLE_SUFFIX = ` | ${siteConfig.name}`

/** Characters as people read them (code points), not UTF-16 units. */
function characters(text: string): number {
  return Array.from(text).length
}

/** The first candidate that fits with the suffix, else the last (the shortest). */
function firstThatFits(candidates: readonly [string, ...string[]]): string {
  return (
    candidates.find(title => characters(`${title}${TITLE_SUFFIX}`) <= TITLE_MAX_LENGTH) ??
    candidates[candidates.length - 1]
  )
}

/**
 * The year in a collection title, read per request (nothing per-environment is prerendered).
 * The edge HTML cache keeps a page at most a day, so a new year shows within a day of it.
 */
export function currentYear(now: Date = new Date()): number {
  return now.getUTCFullYear()
}

/**
 * A listing's title: `{Name} Review, Rating & Alternatives`, then `{Name} Review & Alternatives`,
 * then `{Name} Alternatives` (the highest-intent words for a directory stay longest), then the name.
 */
export function listingTitle(name: string): string {
  const trimmed = name.trim()
  return firstThatFits([
    `${trimmed} Review, Rating & Alternatives`,
    `${trimmed} Review & Alternatives`,
    `${trimmed} Alternatives`,
    trimmed
  ])
}

/** The sentence a listing's meta description leads with: every word of its longest title. */
export function listingDescriptionLead(name: string): string {
  return `${name.trim()} review, rating & alternatives.`
}

/** A collection page: what it ranks, its live count from D1, and the year. */
export interface CollectionTitleInput {
  /** Its size; without one (0) the title has no count. */
  count: number
  year: number
}

interface CollectionTitleParts extends CollectionTitleInput {
  /** `+` after the count: a category or tag grows, a best page lists exactly `count`. */
  plus: boolean
  topic: string
}

/** `{N}+ {best} {Topic}`; without a count, `Best {Topic}` opens the sentence or title. */
function counted({ count, plus, topic }: CollectionTitleParts, best: 'Best' | 'best'): string {
  return count > 0 ? `${count}${plus ? '+' : ''} ${best} ${topic}` : `Best ${topic}`
}

/** `{N} Best {Topic} in {Year}`, then without the year, then without the count. */
function collectionTitle(parts: CollectionTitleParts): string {
  const full = counted(parts, 'Best')
  return firstThatFits([`${full} in ${parts.year}`, full, `Best ${parts.topic}`])
}

/** The sentence a collection's meta description leads with: every word of its longest title. */
function collectionDescriptionLead(parts: CollectionTitleParts): string {
  return `${counted(parts, 'best')} in ${parts.year}.`
}

/**
 * Words a title keeps in their own case when it title-cases an all-lower-case name
 * (`ai time tracking` is "AI Time Tracking"), keyed by their lower case.
 */
const CASED_WORDS = new Map(
  '3D AI API APIs CMS CRM GPU HIPAA HR LLM PDF SaaS SEO SERP SMS SQL UGC UI UX VPN'
    .split(' ')
    .map(word => [word.toLowerCase(), word])
)

/** Words a title-cased name keeps lower case unless they open it. */
const MINOR_WORDS = new Set('a an and as at by for in of on or the to vs with'.split(' '))

/**
 * A name as a title writes it: one typed all in lower case is title-cased, keeping known acronyms
 * upper case; any other is left as written. D1 keeps the name as it is.
 */
function titleCased(name: string): string {
  if (name !== name.toLowerCase()) return name
  let first = true
  return name.replace(/[\p{L}\p{N}]+/gu, word => {
    const opens = first
    first = false
    const cased = CASED_WORDS.get(word)
    if (cased) return cased
    if (!opens && MINOR_WORDS.has(word)) return word
    return `${word.charAt(0).toUpperCase()}${word.slice(1)}`
  })
}

/**
 * The noun a category or tag title adds after a name that isn't already a plural noun for tools
 * (`AI Accounting Software`). Of "Software", "Tools" and "Apps", it had the most US search volume
 * (Ahrefs, October 2026) for 7 of the 13 live names with any: `ai accounting software` 3,100 a
 * month to 520 for "tools", `ecommerce software` 5,000 to 1,150.
 */
export const DEFAULT_TOPIC_NOUN = 'Software'

/**
 * Names, as a title writes them, whose searches clearly favour another noun: `seo tools`
 * (319,000 a month), `best productivity apps` (73,000; 75,500 for "apps" to 2,700 for
 * "software"), `education apps` (790 to 600).
 */
export const TOPIC_NOUN_OVERRIDES: ReadonlyMap<string, string> = new Map([
  ['Education', 'Apps'],
  ['Productivity', 'Apps'],
  ['SEO', 'Tools']
])

/** Last words that name tools without the plural `s` test (`Software`), or with it. */
const TOOL_NOUNS = new Set(
  ['agents', 'apps', 'software', 'tools', DEFAULT_TOPIC_NOUN, ...TOPIC_NOUN_OVERRIDES.values()].map(
    noun => noun.toLowerCase()
  )
)

/** Endings of words that end in "s" without being plural: Business, Status, Analysis, Analytics. */
const NOT_PLURAL_ENDING = /(?:ss|us|is|ics)$/iu

/** Words that end in a plural-looking "s" but name no set of tools. */
const NOT_PLURAL_WORDS = new Set(['news'])

/**
 * Whether a name's last word is already a plural noun for tools (`AI Lyrics Generators`,
 * `Chatbots & Agents`, `Review Management Software`), so it takes no noun. The rule is
 * deliberately simple: a word in `TOOL_NOUNS`, or one ending in a lower-case "s" (so `CMS` is
 * not plural) that is not one of the endings above.
 */
function namesTools(name: string): boolean {
  const last = /(\p{L}+)\P{L}*$/u.exec(name)?.[1]
  if (!last) return false
  const lower = last.toLowerCase()
  if (TOOL_NOUNS.has(lower)) return true
  return last.endsWith('s') && !NOT_PLURAL_ENDING.test(last) && !NOT_PLURAL_WORDS.has(lower)
}

/**
 * What a category or tag title ranks: its name title-cased if D1 has it in lower case, then,
 * unless its last word is already a plural noun for tools, its override noun or
 * `DEFAULT_TOPIC_NOUN`. `AI Lawyer` is "AI Lawyer Software", `Data & Analytics` is
 * "Data & Analytics Software", `SEO` is "SEO Tools", `Productivity` is "Productivity Apps";
 * `AI Lyrics Generators` and `Developer Tools` stay as they are.
 */
function toolsTopic(name: string): string {
  const cased = titleCased(name.trim())
  if (namesTools(cased)) return cased
  return `${cased} ${TOPIC_NOUN_OVERRIDES.get(cased) ?? DEFAULT_TOPIC_NOUN}`
}

/** A category or a tag: it grows, so its count takes a `+`. */
function toolsParts(name: string, input: CollectionTitleInput): CollectionTitleParts {
  return { ...input, plus: true, topic: toolsTopic(name) }
}

/** A category's title: `{N}+ Best {Category} Software in {Year}`, stepping down. */
export function categoryTitle(name: string, input: CollectionTitleInput): string {
  return collectionTitle(toolsParts(name, input))
}

export function categoryDescriptionLead(name: string, input: CollectionTitleInput): string {
  return collectionDescriptionLead(toolsParts(name, input))
}

/** A tag's title: `{N}+ Best {Tag} Software in {Year}` by the same rule, stepping down. */
export function tagTitle(name: string, input: CollectionTitleInput): string {
  return collectionTitle(toolsParts(name, input))
}

export function tagDescriptionLead(name: string, input: CollectionTitleInput): string {
  return collectionDescriptionLead(toolsParts(name, input))
}

/** What a best page ranks: its D1 title without the leading "Best" its titles are written with. */
function bestPageTopic(title: string): string {
  const trimmed = title.trim()
  return trimmed.replace(/^best\s+/iu, '') || trimmed
}

function bestPageParts(title: string, input: CollectionTitleInput): CollectionTitleParts {
  return { ...input, plus: false, topic: bestPageTopic(title) }
}

/** A best page's title: `{N} Best {Keyword} in {Year}` with its exact entry count, stepping down. */
export function bestPageTitle(title: string, input: CollectionTitleInput): string {
  return collectionTitle(bestPageParts(title, input))
}

export function bestPageDescriptionLead(title: string, input: CollectionTitleInput): string {
  return collectionDescriptionLead(bestPageParts(title, input))
}

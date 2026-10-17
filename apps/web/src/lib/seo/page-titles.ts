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
 * A category's last word already names a kind of tool (Developer Tools, Video Downloaders,
 * Chatbots & Agents), so it takes no second noun.
 */
const NAMES_A_KIND_OF_TOOL = /(?:tools|[eo]rs|[ae]nts|bots)$/iu

/** `Audio & Music Tools`; `Developer Tools` and `Video Downloaders` as they are. */
function categoryTopic(name: string): string {
  const trimmed = name.trim()
  return NAMES_A_KIND_OF_TOOL.test(trimmed) ? trimmed : `${trimmed} Tools`
}

function categoryParts(name: string, input: CollectionTitleInput): CollectionTitleParts {
  return { ...input, plus: true, topic: categoryTopic(name) }
}

/** A category's title: `{N}+ Best {Category} Tools in {Year}`, stepping down. */
export function categoryTitle(name: string, input: CollectionTitleInput): string {
  return collectionTitle(categoryParts(name, input))
}

export function categoryDescriptionLead(name: string, input: CollectionTitleInput): string {
  return collectionDescriptionLead(categoryParts(name, input))
}

function tagParts(name: string, input: CollectionTitleInput): CollectionTitleParts {
  return { ...input, plus: true, topic: name.trim() }
}

/** A tag's title: `{N}+ Best {Label} in {Year}`, stepping down. */
export function tagTitle(name: string, input: CollectionTitleInput): string {
  return collectionTitle(tagParts(name, input))
}

export function tagDescriptionLead(name: string, input: CollectionTitleInput): string {
  return collectionDescriptionLead(tagParts(name, input))
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

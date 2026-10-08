import { SITE_NAME } from './seo-config'
import { siteCopy } from '../site/site-copy'

export function generateAltText(
  type: 'favicon' | 'avatar' | 'logo' | 'website',
  name: string
): string {
  switch (type) {
    case 'favicon':
      return `${name} favicon`
    case 'avatar':
      return `${name} profile picture`
    case 'logo':
      return `${SITE_NAME} logo`
    case 'website':
      return `${name} ${siteCopy.listingName.singular}`
    default:
      return name
  }
}

export function formatPageTitle(title: string, includeSiteName = true): string {
  const cleanTitle = title.trim()
  if (!includeSiteName || cleanTitle.includes(SITE_NAME)) {
    return cleanTitle
  }
  return `${cleanTitle} | ${SITE_NAME}`
}

export function optimizeMetaDescription(description: string, maxLength = 160): string {
  if (description.length <= maxLength) {
    return description
  }

  const truncated = description.substring(0, maxLength - 3)
  const lastSpace = truncated.lastIndexOf(' ')
  return `${truncated.substring(0, lastSpace)}...`
}

/** Search results show up to about 160 characters; under about 110 the snippet is thin. */
export const META_DESCRIPTION_MIN_LENGTH = 110
export const META_DESCRIPTION_MAX_LENGTH = 160

function asSentence(text: string): string {
  const trimmed = text.trim()
  return !trimmed || /[.!?…]$/u.test(trimmed) ? trimmed : `${trimmed}.`
}

/**
 * A meta description from `base`, padded with extra sentences while it is under the minimum
 * length (#151). Each entry of `extras` is a list of alternatives, longest first: the first
 * one that keeps the description within the maximum is appended. A base already over the
 * maximum is truncated at a word.
 */
export function composeMetaDescription(base: string, extras: string[][] = []): string {
  let description = asSentence(base)
  for (const alternatives of extras) {
    if (description.length >= META_DESCRIPTION_MIN_LENGTH) break
    const next = alternatives
      .map(sentence => `${description} ${asSentence(sentence)}`)
      .find(candidate => candidate.length <= META_DESCRIPTION_MAX_LENGTH)
    if (next) description = next
  }
  return optimizeMetaDescription(description, META_DESCRIPTION_MAX_LENGTH)
}

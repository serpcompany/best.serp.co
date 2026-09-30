import { type SiteConfig, siteConfig } from './site-config'

export type ResolvedSiteCopy = {
  allLabel: string
  allAnchorId: string
  brandsLabel: string
  categoryEmptyDescription: string
  categoryEmptyTitle: string
  docsLabel: string
  exploreAllLabel: string
  listingCountLabel: string
  listingName: SiteConfig['copy']['listingName'] & {
    pluralTitle: string
    singularTitle: string
  }
  listingSearchPlaceholder: string
  networkLabel: string
  submitLabelSentence: string
  submitLabel: string
}

function toTitleCase(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`
}

function toAnchorId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
}

function toSentenceCase(value: string): string {
  return value.trim().toLowerCase()
}

export function resolveSiteCopy(config: SiteConfig = siteConfig): ResolvedSiteCopy {
  const { plural, singular } = config.copy.listingName
  const pluralTitle = toTitleCase(plural)
  const singularTitle = toTitleCase(singular)
  const submitLabelSentence = toSentenceCase(config.copy.submitLabel)

  return {
    allLabel: `All ${pluralTitle}`,
    allAnchorId: `all-${toAnchorId(plural)}`,
    brandsLabel: config.copy.brandsLabel,
    categoryEmptyDescription: `There are no ${plural} in this category yet. Try checking back later or ${submitLabelSentence}.`,
    categoryEmptyTitle: `No ${plural} found`,
    docsLabel: config.copy.docsLabel,
    exploreAllLabel: `Explore All ${pluralTitle}`,
    listingCountLabel: `${pluralTitle} in directory`,
    listingName: {
      plural,
      pluralTitle,
      singular,
      singularTitle
    },
    listingSearchPlaceholder: `Search ${plural}, categories, and descriptions...`,
    networkLabel: config.copy.networkLabel,
    submitLabelSentence,
    submitLabel: config.copy.submitLabel
  }
}

export const siteCopy: ResolvedSiteCopy = resolveSiteCopy()

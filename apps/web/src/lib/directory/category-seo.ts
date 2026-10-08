import { siteConfig } from '../site/site-config'
import { siteCopy } from '../site/site-copy'
import type { Category } from './categories'

interface CategorySEOConfig {
  metaTitle: string
  metaDescription: string
  keywords: string[]
  h1Title: string
  introText: string
  faqQuestions?: Array<{
    question: string
    answer: string
  }>
}

function toKeywordValue(value: string): string {
  return value.trim().toLowerCase()
}

export function getCategorySEO(_slug: string, category: Category): CategorySEOConfig {
  // The category record (from D1) carries the canonical display name.
  const categoryName = siteConfig.copy.categoryLabels[category.slug] ?? category.name
  const categoryDescription = category.description

  return {
    metaTitle: `${categoryName} ${siteCopy.listingName.pluralTitle} Directory`,
    metaDescription: `Discover curated ${toKeywordValue(categoryName)} ${
      siteCopy.listingName.plural
    } and resources. ${categoryDescription}`,
    keywords: [
      toKeywordValue(categoryName),
      `${toKeywordValue(categoryName)} ${siteCopy.listingName.plural}`,
      `directory ${siteCopy.listingName.plural}`,
      'listing directory',
      'curated resources'
    ],
    h1Title: categoryName,
    introText: categoryDescription
  }
}

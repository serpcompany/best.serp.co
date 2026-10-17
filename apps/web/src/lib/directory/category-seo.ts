import type { PublishedCategory } from '@/db/contracts'
import { siteCopy } from '../site/site-copy'

interface CategorySEOConfig {
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

export function getCategorySEO(
  _slug: string,
  category: Pick<PublishedCategory, 'description' | 'name'>
): CategorySEOConfig {
  // The category record (from D1) carries the display name.
  const categoryName = category.name
  const categoryDescription = category.description

  return {
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

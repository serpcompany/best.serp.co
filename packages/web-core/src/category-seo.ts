import { getCategoryDisplayName } from './category-display';
import type { Category } from './categories';
import { siteCopy } from './site-copy';

interface CategorySEOConfig {
  metaTitle: string;
  metaDescription: string;
  keywords: string[];
  h1Title: string;
  introText: string;
  faqQuestions?: Array<{
    question: string;
    answer: string;
  }>;
}

function toKeywordValue(value: string): string {
  return value.trim().toLowerCase();
}

export function getCategorySEO(
  _slug: string,
  category: Category
): CategorySEOConfig {
  const categoryName = getCategoryDisplayName(category.slug);
  const categoryDescription = category.description;

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
      'curated resources',
    ],
    h1Title: categoryName,
    introText: categoryDescription,
  };
}

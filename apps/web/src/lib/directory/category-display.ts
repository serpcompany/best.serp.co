import { siteConfig } from '../site/site-config'
import { type Category, getCategoryBySlug, normalizeCategorySlug } from './categories'

export interface DisplayCategory extends Category {
  displayName: string
}

export function resolveCategoryDisplayName(
  slug: string,
  categoryLabels: Record<string, string> = {}
): string {
  const normalizedSlug = normalizeCategorySlug(slug)
  const category = getCategoryBySlug(normalizedSlug)

  return categoryLabels[slug] ?? categoryLabels[normalizedSlug] ?? category?.name ?? normalizedSlug
}

export function getCategoryDisplayName(slug: string): string {
  return resolveCategoryDisplayName(slug, siteConfig.copy.categoryLabels)
}

export function getDisplayCategory(category: Category): DisplayCategory {
  return {
    ...category,
    displayName: getCategoryDisplayName(category.slug)
  }
}

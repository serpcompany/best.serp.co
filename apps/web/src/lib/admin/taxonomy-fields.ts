/**
 * The fields of the admin's category, tag, and best page forms (#405), shared by the forms and
 * the decisions that check them. A slug is a URL segment (`/products/categories/<slug>/`,
 * `/products/tags/<slug>/`, `/best/<slug>/`): lowercase letters and digits in hyphenated words.
 */

export const TAXONOMY_LIMITS = {
  description: 500,
  intro: 2_000,
  keyword: 120,
  name: 80,
  order: 9_999,
  slug: 80,
  title: 120
} as const

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

/** True for a slug a new or renamed category, tag, or best page may take. */
export function isTaxonomySlug(value: string): boolean {
  return value.length <= TAXONOMY_LIMITS.slug && SLUG.test(value)
}

/** A slug from a name or keyword: "AI Photo Editor" is `ai-photo-editor`. */
export function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/gu, '')
    .toLowerCase()
    .replace(/&/gu, ' and ')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, TAXONOMY_LIMITS.slug)
    .replace(/-+$/u, '')
}

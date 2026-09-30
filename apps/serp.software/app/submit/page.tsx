import { SubmitPageSurface } from '@serpdirectory/web-core/forms/submit-page-surface'
import type { Metadata } from 'next'
import { getActiveCategories } from '@/lib/catalog/repository'

export const metadata: Metadata = {
  title: 'Submit Yours',
  description: 'Submit your downloader software product to SERP Software.'
}

export default async function SubmitPage() {
  const categories = await getActiveCategories()

  return (
    <SubmitPageSurface
      categoryOptions={categories.map(category => ({
        label: category.name,
        slug: category.slug
      }))}
    />
  )
}

import { SITE_NAME, SITE_PUBLIC_URL } from '@serpdirectory/web-core/seo-config'
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

export function generateMetadata(): Metadata {
  return {
    title: `Directory - ${SITE_NAME}`,
    description: 'Discover a curated list of directory listings and resources.',
    alternates: {
      canonical: `${SITE_PUBLIC_URL}/`
    }
  }
}

export default function ProjectsPage() {
  // Redirect to homepage where all listings are now displayed
  redirect('/')
}

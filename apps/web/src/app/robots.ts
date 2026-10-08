import type { MetadataRoute } from 'next'
import { createCanonicalRobots } from '@/lib/seo/sitemaps'

export const dynamic = 'force-static'

export default function robots(): MetadataRoute.Robots {
  return createCanonicalRobots()
}

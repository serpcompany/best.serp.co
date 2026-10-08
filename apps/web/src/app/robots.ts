import { createCanonicalRobots } from '@serpdirectory/web-core/sitemaps'
import type { MetadataRoute } from 'next'

export const dynamic = 'force-static'

export default function robots(): MetadataRoute.Robots {
  return createCanonicalRobots()
}

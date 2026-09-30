import { z } from 'zod'

export const SEARCH_API_PATH = '/api/search'

export const searchResultSchema = z.object({
  category: z.string(),
  categories: z.array(z.string()).optional(),
  content: z.string().optional(),
  description: z.string(),
  name: z.string().min(1),
  slug: z.string().min(1),
  url: z.string().min(1),
  website: z.string()
})

export const searchResponseSchema = z.array(searchResultSchema)

export type SearchResult = z.infer<typeof searchResultSchema>

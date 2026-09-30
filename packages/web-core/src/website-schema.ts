import { isValidAssetReference } from '@serpdirectory/site-contract/asset-reference'
import { z } from 'zod'

const publishedAtPattern = /^\d{4}-\d{2}-\d{2}$/

export const websitePrioritySchema = z.enum(['high', 'medium', 'low'])
export const websiteResourceLinkSchema = z.object({
  label: z.string().trim().min(1, 'resourceLinks.label is required'),
  url: z.string().url('resourceLinks.url must be a valid URL')
})
export const websiteMediaSchema = z
  .object({
    images: z
      .array(
        z.string().refine(isValidAssetReference, {
          message: 'media.images must contain valid HTTPS URLs or root-relative asset paths'
        })
      )
      .optional(),
    logo: z
      .string()
      .refine(isValidAssetReference, {
        message: 'media.logo must be a valid HTTPS URL or root-relative asset path'
      })
      .optional(),
    video: z
      .string()
      .refine(isValidAssetReference, {
        message: 'media.video must be a valid HTTPS URL or root-relative asset path'
      })
      .optional()
  })
  .refine(media => Boolean(media.images?.length || media.logo || media.video), {
    message: 'media must include at least one URL'
  })

export const websiteEntrySchema = z
  .object({
    category: z.string().trim().min(1, 'category must not be empty').optional(),
    categories: z
      .array(z.string().trim().min(1, 'categories must not contain empty slugs'))
      .min(1, 'categories must include at least one slug')
      .optional(),
    content: z.string().min(1, 'content must not be empty').optional(),
    description: z.string().trim().min(1, 'description is required'),
    domain: z.string().url('domain must be a valid URL').optional(),
    entityType: z
      .string()
      .trim()
      .regex(/^[a-z0-9-]+$/, 'entityType must use kebab-case')
      .optional(),
    favicon: z.string().url('favicon must be a valid URL').optional(),
    featured: z.boolean().optional(),
    isUnofficial: z.boolean().optional(),
    media: websiteMediaSchema.optional(),
    name: z.string().trim().min(1, 'name is required'),
    priority: websitePrioritySchema.optional(),
    publishedAt: z.string().regex(publishedAtPattern, 'publishedAt must use YYYY-MM-DD format'),
    resourceLinks: z.array(websiteResourceLinkSchema).optional(),
    slug: z.string().trim().min(1, 'slug must not be empty').optional(),
    website: z.string().url('website must be a valid URL').optional()
  })
  .superRefine((entry, context) => {
    if (!entry.category && (!entry.categories || entry.categories.length === 0)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'category or categories is required',
        path: ['categories']
      })
    }

    if (!entry.website && !entry.domain) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'website or domain is required',
        path: ['website']
      })
    }
  })

export type WebsiteEntry = z.infer<typeof websiteEntrySchema>
export type WebsiteMedia = z.infer<typeof websiteMediaSchema>
export type WebsitePriority = z.infer<typeof websitePrioritySchema>
export type WebsiteResourceLink = z.infer<typeof websiteResourceLinkSchema>

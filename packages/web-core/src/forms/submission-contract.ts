import { z } from 'zod'

export const BADGE_VERIFIER_USER_AGENT = 'SERPSoftwareBadgeVerifier/1.0'

const publicUrl = z
  .string()
  .trim()
  .url()
  .refine(value => /^https?:\/\//i.test(value), {
    message: 'Use a complete http:// or https:// URL.'
  })

export const submissionRequestSchema = z.object({
  category: z.string().trim().min(1).max(100),
  content: z.string().trim().min(10).max(5000),
  description: z.string().trim().min(10).max(300),
  faqs: z
    .array(
      z.object({
        question: z.string().trim().min(1).max(160),
        answer: z.string().trim().min(1).max(1200)
      })
    )
    .max(5),
  logoUrl: publicUrl,
  name: z.string().trim().min(2).max(120),
  resourceLinks: z
    .array(z.object({ label: z.string().trim().min(1).max(80), url: publicUrl }))
    .max(5),
  videoUrl: z
    .union([publicUrl, z.literal('')])
    .optional()
    .default(''),
  website: publicUrl
})

export const submissionCapabilitySchema = z.object({
  token: z.string().min(32).max(256)
})

export type SubmissionRequest = z.infer<typeof submissionRequestSchema>

export function submissionSlug(website: string): string {
  return new URL(website).hostname.replace(/^www\./, '').toLowerCase()
}

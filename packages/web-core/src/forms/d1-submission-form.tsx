'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@serpdirectory/design-system/dialog'
import { Check, Copy, ExternalLink } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useFieldArray, useForm } from 'react-hook-form'
import { z } from 'zod'
import { siteConfig } from '../site-config'
import { siteCopy } from '../site-copy'
import { buildFeaturedOnBadgeEmbedHtml } from '../website/featured-on-badge-embed-panel'
import {
  getFeaturedOnBadgeListingUrl,
  getFeaturedOnBadgePreviewPathFromKey,
  getFeaturedOnBadgePublicUrlFromKey
} from '../website/featured-on-badge-url'
import {
  type BadgeVerificationDiagnostic,
  getBadgeVerificationDiagnostic
} from './badge-verification-diagnostic'

export interface CategoryOption {
  label: string
  slug: string
}

const HTTPS_PREFIX = 'https://'
const MAX_FAQS = 5
const MAX_RESOURCE_LINKS = 5
const SUBMISSION_RESUME_STORAGE_KEY = 'serp.software:submission-verification'
type BadgeTheme = 'light' | 'dark'

type BadgeSubmissionInstructions = {
  badgeEmbeds: Record<BadgeTheme, string>
  badgePreviewPaths: Record<BadgeTheme, string>
  submissionId: string
  token: string
  listingUrl: string
  name: string
  siteName: string
  website: string
}

const submissionResumeCapabilitySchema = z.object({
  submissionId: z.string().uuid(),
  token: z.string().min(32).max(256)
})

type SubmissionResumeCapability = z.infer<typeof submissionResumeCapabilitySchema>

export function buildSubmissionResumeHash(capability: SubmissionResumeCapability): string {
  const parsed = submissionResumeCapabilitySchema.parse(capability)
  return `#${new URLSearchParams({
    submission: parsed.submissionId,
    token: parsed.token
  }).toString()}`
}

export function parseSubmissionResumeHash(hash: string): SubmissionResumeCapability | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''))
  const parsed = submissionResumeCapabilitySchema.safeParse({
    submissionId: params.get('submission'),
    token: params.get('token')
  })
  return parsed.success ? parsed.data : null
}

function readStoredResumeCapability(): SubmissionResumeCapability | null {
  try {
    const stored = window.localStorage.getItem(SUBMISSION_RESUME_STORAGE_KEY)
    if (!stored) return null
    const parsed = submissionResumeCapabilitySchema.safeParse(JSON.parse(stored))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function storeResumeCapability(capability: SubmissionResumeCapability): void {
  try {
    window.localStorage.setItem(SUBMISSION_RESUME_STORAGE_KEY, JSON.stringify(capability))
  } catch {
    // The fragment remains a portable recovery path when browser storage is unavailable.
  }
  try {
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${window.location.search}${buildSubmissionResumeHash(capability)}`
    )
  } catch {
    // Saving the D1 submission must not be reported as failed because history is unavailable.
  }
}

function clearResumeCapability(): void {
  try {
    window.localStorage.removeItem(SUBMISSION_RESUME_STORAGE_KEY)
  } catch {
    // Browser storage may be disabled.
  }
  try {
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
  } catch {
    // The server-side status still prevents a completed session from re-entering review.
  }
}

function hasCompleteHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname)
  } catch {
    return false
  }
}

function isEmptyUrlField(value: string): boolean {
  const trimmedValue = value.trim()
  return !trimmedValue || trimmedValue === HTTPS_PREFIX
}

function getSubmissionSlug(website: string): string {
  try {
    return new URL(website).hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return ''
  }
}

export function buildBadgeSubmissionInstructions({
  submissionId,
  token,
  name,
  website
}: {
  submissionId: string
  token: string
  name: string
  website: string
}): BadgeSubmissionInstructions {
  const siteName = siteConfig.badges.featuredOn.displayName
  const slug = getSubmissionSlug(website)
  const listingUrl = getFeaturedOnBadgeListingUrl({
    listingBasePath: siteConfig.listingRouteBasePath,
    listingDetailSuffix: siteConfig.sitemap.listingDetailSuffix,
    publicUrl: siteConfig.publicUrl,
    slug
  })
  const badgeKeys = siteConfig.badges.featuredOn
  const badgeUrls = {
    dark: getFeaturedOnBadgePublicUrlFromKey(badgeKeys.dark, siteConfig.publicUrl),
    light: getFeaturedOnBadgePublicUrlFromKey(badgeKeys.light, siteConfig.publicUrl)
  }

  return {
    badgeEmbeds: {
      dark: buildFeaturedOnBadgeEmbedHtml({
        badgeUrl: badgeUrls.dark,
        listingUrl,
        siteName
      }),
      light: buildFeaturedOnBadgeEmbedHtml({
        badgeUrl: badgeUrls.light,
        listingUrl,
        siteName
      })
    },
    badgePreviewPaths: {
      dark: getFeaturedOnBadgePreviewPathFromKey(badgeKeys.dark),
      light: getFeaturedOnBadgePreviewPathFromKey(badgeKeys.light)
    },
    submissionId,
    token,
    listingUrl,
    name,
    siteName,
    website
  }
}

const requiredUrlSchema = z
  .string()
  .trim()
  .refine(value => !isEmptyUrlField(value), {
    message: 'Enter a full URL, including the domain.'
  })
  .refine(hasCompleteHttpUrl, {
    message: 'Enter a valid URL that starts with http:// or https://.'
  })

const optionalUrlSchema = z
  .string()
  .trim()
  .refine(value => isEmptyUrlField(value) || hasCompleteHttpUrl(value), {
    message: 'Enter a valid URL that starts with http:// or https://.'
  })

const optionalResourceLinkSchema = z
  .object({
    label: z.string().trim().max(80, 'Keep link labels under 80 characters.'),
    url: optionalUrlSchema
  })
  .superRefine((link, context) => {
    const hasLabel = Boolean(link.label.trim())
    const hasUrl = !isEmptyUrlField(link.url)

    if (!hasLabel && !hasUrl) {
      return
    }

    if (!hasLabel) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Enter a resource label.',
        path: ['label']
      })
    }

    if (!hasUrl) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Enter a full URL, including the domain.',
        path: ['url']
      })
    }
  })

const optionalFaqSchema = z
  .object({
    answer: z.string().trim().max(1200, 'Keep FAQ answers under 1,200 characters.'),
    question: z.string().trim().max(160, 'Keep FAQ questions under 160 characters.')
  })
  .superRefine((faq, context) => {
    const hasAnswer = Boolean(faq.answer.trim())
    const hasQuestion = Boolean(faq.question.trim())

    if (!hasAnswer && !hasQuestion) {
      return
    }

    if (!hasQuestion) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Enter a question.',
        path: ['question']
      })
    }

    if (!hasAnswer) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Enter an answer.',
        path: ['answer']
      })
    }
  })

const submissionFormSchema = z.object({
  category: z.string().trim().min(1, 'Choose a category.'),
  content: z
    .string()
    .trim()
    .min(10, 'Full description must be at least 10 characters.')
    .max(5000, 'Keep the full description under 5,000 characters.'),
  description: z
    .string()
    .trim()
    .min(10, 'Short description must be at least 10 characters.')
    .max(300, 'Keep the short description under 300 characters.'),
  name: z
    .string()
    .trim()
    .min(2, 'Name must be at least 2 characters.')
    .max(120, 'Keep the name under 120 characters.'),
  faqs: z.array(optionalFaqSchema).max(MAX_FAQS),
  logoUrl: requiredUrlSchema,
  resourceLinks: z.array(optionalResourceLinkSchema).max(MAX_RESOURCE_LINKS),
  videoUrl: optionalUrlSchema,
  website: requiredUrlSchema
})

type SubmissionFormValues = z.infer<typeof submissionFormSchema>

const INITIAL_FORM_STATE: SubmissionFormValues = {
  category: '',
  content: '',
  description: '',
  faqs: [{ answer: '', question: '' }],
  logoUrl: HTTPS_PREFIX,
  name: '',
  resourceLinks: [{ label: '', url: '' }],
  videoUrl: '',
  website: HTTPS_PREFIX
}

function FieldError({ message }: { message?: string }) {
  if (!message) {
    return null
  }

  return <p className="text-xs text-red-600 dark:text-red-400">{message}</p>
}

function FieldLabel({
  children,
  required = false
}: {
  children: React.ReactNode
  required?: boolean
}) {
  return (
    <span className="text-sm font-medium">
      {children}
      {required ? (
        <span aria-hidden="true" className="text-red-500">
          {' '}
          *
        </span>
      ) : null}
    </span>
  )
}

function VerificationDiagnosticAlert({ diagnostic }: { diagnostic: BadgeVerificationDiagnostic }) {
  return (
    <div
      className="rounded-md border border-amber-300 bg-amber-50 p-4 text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-50"
      role="alert"
    >
      <p className="text-sm font-bold">{diagnostic.title}</p>
      <p className="mt-1 text-sm">{diagnostic.message}</p>
    </div>
  )
}

export function D1SubmissionForm({
  categoryOptions
}: {
  categoryOptions: readonly CategoryOption[]
}) {
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [copiedTheme, setCopiedTheme] = useState<BadgeTheme | null>(null)
  const [copiedResumeLink, setCopiedResumeLink] = useState(false)
  const [badgeInstructions, setBadgeInstructions] = useState<BadgeSubmissionInstructions | null>(
    null
  )
  const [isRestoringSubmission, setIsRestoringSubmission] = useState(false)
  const [verificationDialogOpen, setVerificationDialogOpen] = useState(false)
  const [verificationFailureCode, setVerificationFailureCode] = useState<string | null>(null)
  const [verificationState, setVerificationState] = useState<'pending' | 'checking' | 'verified'>(
    'pending'
  )
  const listingLabel = siteCopy.listingName.singularTitle
  const {
    control,
    formState: { errors, isSubmitting, isValid },
    handleSubmit,
    register,
    reset,
    watch
  } = useForm<SubmissionFormValues>({
    defaultValues: INITIAL_FORM_STATE,
    mode: 'onChange',
    resolver: zodResolver(submissionFormSchema)
  })
  const {
    append: appendResourceLink,
    fields: resourceLinkFields,
    remove: removeResourceLink
  } = useFieldArray({
    control,
    name: 'resourceLinks'
  })
  const {
    append: appendFaq,
    fields: faqFields,
    remove: removeFaq
  } = useFieldArray({
    control,
    name: 'faqs'
  })
  const watchedFaqs = watch('faqs')
  const watchedResourceLinks = watch('resourceLinks')
  const hasPartiallyFilledFaq = watchedFaqs.some(
    faq => Boolean(faq.question.trim()) !== Boolean(faq.answer.trim())
  )
  const hasPartiallyFilledResourceLink = watchedResourceLinks.some(
    link => Boolean(link.label.trim()) !== !isEmptyUrlField(link.url)
  )

  const isSubmitDisabled =
    !isValid || isSubmitting || hasPartiallyFilledFaq || hasPartiallyFilledResourceLink
  const verificationDiagnostic =
    badgeInstructions && verificationFailureCode
      ? getBadgeVerificationDiagnostic(verificationFailureCode, badgeInstructions.website)
      : null

  useEffect(() => {
    const capability =
      parseSubmissionResumeHash(window.location.hash) || readStoredResumeCapability()
    if (!capability) return

    const controller = new AbortController()
    setIsRestoringSubmission(true)
    storeResumeCapability(capability)

    void (async () => {
      try {
        const response = await fetch(
          `/api/submissions/${capability.submissionId}?token=${encodeURIComponent(capability.token)}`,
          { signal: controller.signal }
        )
        const result = (await response.json()) as {
          error?: string
          lastVerificationError?: string | null
          name?: string
          status?: 'pending_badge' | 'verified' | 'approved' | 'rejected'
          website?: string
        }
        if (!response.ok || !result.name || !result.website || !result.status) {
          if (response.status === 404) clearResumeCapability()
          throw new Error(result.error || 'Unable to restore this saved submission.')
        }
        if (result.status === 'approved' || result.status === 'rejected') {
          clearResumeCapability()
          throw new Error(
            result.status === 'approved'
              ? 'This submission has already been approved.'
              : 'This submission has been declined.'
          )
        }

        setBadgeInstructions(
          buildBadgeSubmissionInstructions({
            submissionId: capability.submissionId,
            token: capability.token,
            name: result.name,
            website: result.website
          })
        )
        setVerificationState(result.status === 'verified' ? 'verified' : 'pending')
        setVerificationFailureCode(
          result.status === 'pending_badge' ? result.lastVerificationError || null : null
        )
        setVerificationDialogOpen(result.status !== 'verified')
        if (result.status === 'verified') clearResumeCapability()
      } catch (error) {
        if (!controller.signal.aborted) {
          setSubmitError(
            error instanceof Error ? error.message : 'Unable to restore this saved submission.'
          )
        }
      } finally {
        if (!controller.signal.aborted) setIsRestoringSubmission(false)
      }
    })()

    return () => controller.abort()
  }, [])

  async function handleValidSubmit(values: SubmissionFormValues): Promise<void> {
    setSubmitError(null)
    try {
      const response = await fetch('/api/submissions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...values,
          faqs: values.faqs.filter(faq => faq.question.trim() && faq.answer.trim()),
          resourceLinks: values.resourceLinks.filter(
            resourceLink => resourceLink.label.trim() && !isEmptyUrlField(resourceLink.url)
          )
        })
      })
      const result = (await response.json()) as { error?: string; id?: string; token?: string }
      if (!response.ok || !result.id || !result.token) {
        throw new Error(result.error || 'Unable to save your submission.')
      }
      const capability = { submissionId: result.id, token: result.token }
      const instructions = buildBadgeSubmissionInstructions({
        ...capability,
        name: values.name,
        website: values.website
      })
      storeResumeCapability(capability)
      setBadgeInstructions(instructions)
      setVerificationState('pending')
      setVerificationFailureCode(null)
      setVerificationDialogOpen(true)
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Unable to save your submission.')
    }
  }

  function handleReset(): void {
    clearResumeCapability()
    reset(INITIAL_FORM_STATE)
    setSubmitError(null)
    setBadgeInstructions(null)
    setCopiedTheme(null)
    setCopiedResumeLink(false)
    setVerificationFailureCode(null)
    setVerificationState('pending')
    setVerificationDialogOpen(false)
  }

  async function handleVerifyBadge(): Promise<void> {
    if (!badgeInstructions) {
      return
    }
    setSubmitError(null)
    setVerificationState('checking')
    try {
      const response = await fetch(`/api/submissions/${badgeInstructions.submissionId}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: badgeInstructions.token })
      })
      const result = (await response.json()) as {
        code?: string
        error?: string
        lastVerificationError?: string | null
        status?: string
      }
      if (!response.ok || result.status !== 'verified') {
        setVerificationFailureCode(
          result.lastVerificationError || result.code || 'verification_service_error'
        )
        setVerificationState('pending')
        return
      }
      setVerificationState('verified')
      setVerificationFailureCode(null)
      clearResumeCapability()
    } catch {
      setVerificationState('pending')
      setVerificationFailureCode('verification_service_error')
    }
  }

  async function handleCopyBadge(theme: BadgeTheme): Promise<void> {
    if (!badgeInstructions) {
      return
    }

    await navigator.clipboard.writeText(badgeInstructions.badgeEmbeds[theme])
    setCopiedTheme(theme)
    setTimeout(() => setCopiedTheme(null), 2000)
  }

  async function handleCopyResumeLink(): Promise<void> {
    if (!badgeInstructions) return
    try {
      const hash = buildSubmissionResumeHash({
        submissionId: badgeInstructions.submissionId,
        token: badgeInstructions.token
      })
      await navigator.clipboard.writeText(
        `${window.location.origin}${window.location.pathname}${hash}`
      )
      setCopiedResumeLink(true)
      setTimeout(() => setCopiedResumeLink(false), 2000)
    } catch {
      setSubmitError('Unable to copy the private resume link. Bookmark this page instead.')
    }
  }

  return (
    <div className="space-y-8">
      <div className="space-y-4">
        <h1 className="text-3xl font-bold">{siteCopy.submitLabel}</h1>
      </div>

      {submitError ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-900 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-100">
          {submitError}
        </div>
      ) : null}

      {isRestoringSubmission ? (
        <div
          className="rounded-lg border border-border bg-muted/30 p-5 text-sm text-muted-foreground"
          role="status"
        >
          Restoring your saved submission…
        </div>
      ) : null}

      {badgeInstructions ? (
        <section
          className="space-y-4 rounded-lg border border-emerald-300 bg-emerald-50 p-5 text-emerald-950 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-50"
          aria-labelledby="saved-submission-heading"
        >
          <div>
            <p className="text-xs font-bold uppercase tracking-wide">
              {verificationState === 'verified' ? 'Step 2 complete' : 'Step 1 complete'}
            </p>
            <h2 id="saved-submission-heading" className="mt-1 text-xl font-bold">
              {verificationState === 'verified' ? 'Submission verified' : 'Submission saved'}
            </h2>
          </div>
          <p className="text-sm">
            {verificationState === 'verified'
              ? `${badgeInstructions.name} is in the maintainer review queue. The administrator will be notified within a few minutes.`
              : `${badgeInstructions.name} is safely stored in D1. You can close this page and finish badge verification later; this browser will remember your submission.`}
          </p>
          {verificationDiagnostic && !verificationDialogOpen ? (
            <VerificationDiagnosticAlert diagnostic={verificationDiagnostic} />
          ) : null}
          <div className="flex flex-wrap gap-3">
            {verificationState !== 'verified' ? (
              <>
                <button
                  type="button"
                  onClick={() => setVerificationDialogOpen(true)}
                  className="inline-flex items-center justify-center rounded-none bg-emerald-950 px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-emerald-900 dark:bg-emerald-50 dark:text-emerald-950 dark:hover:bg-white"
                >
                  Continue badge verification
                </button>
                <button
                  type="button"
                  onClick={() => void handleCopyResumeLink()}
                  className="inline-flex items-center gap-2 rounded-none border border-emerald-700 px-4 py-2 text-sm font-bold transition-colors hover:bg-emerald-100 dark:border-emerald-300 dark:hover:bg-emerald-900"
                >
                  {copiedResumeLink ? <Check className="size-4" /> : <Copy className="size-4" />}
                  {copiedResumeLink ? 'Resume link copied' : 'Copy private resume link'}
                </button>
              </>
            ) : null}
            <button
              type="button"
              onClick={handleReset}
              className="inline-flex items-center justify-center rounded-none border border-emerald-700 px-4 py-2 text-sm font-bold transition-colors hover:bg-emerald-100 dark:border-emerald-300 dark:hover:bg-emerald-900"
            >
              Start another submission
            </button>
          </div>
          {verificationState !== 'verified' ? (
            <p className="text-xs opacity-80">
              Keep the resume link private. It grants access to this submission’s verification step.
            </p>
          ) : null}
        </section>
      ) : null}

      {!badgeInstructions && !isRestoringSubmission ? (
        <form className="space-y-6" noValidate onSubmit={handleSubmit(handleValidSubmit)}>
          <div className="grid gap-6 md:grid-cols-2">
            <label className="space-y-2">
              <FieldLabel required>Name</FieldLabel>
              <input
                required
                type="text"
                aria-label="Name"
                aria-invalid={errors.name ? 'true' : 'false'}
                {...register('name')}
                className="w-full rounded-lg border border-input bg-background px-4 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                placeholder={`Example ${listingLabel}`}
              />
              <FieldError message={errors.name?.message} />
            </label>

            <label className="space-y-2">
              <FieldLabel required>Category</FieldLabel>
              <select
                required
                aria-label="Category"
                aria-invalid={errors.category ? 'true' : 'false'}
                {...register('category')}
                className="w-full rounded-lg border border-input bg-background px-4 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <option value="">Choose a category</option>
                {categoryOptions.map(category => (
                  <option key={category.slug} value={category.slug}>
                    {category.label}
                  </option>
                ))}
              </select>
              <FieldError message={errors.category?.message} />
            </label>

            <label className="space-y-2 md:col-span-2">
              <FieldLabel required>Website URL</FieldLabel>
              <input
                required
                type="url"
                aria-label="Website URL"
                aria-invalid={errors.website ? 'true' : 'false'}
                {...register('website')}
                className="w-full rounded-lg border border-input bg-background px-4 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                placeholder="https://example.com"
              />
              <FieldError message={errors.website?.message} />
            </label>

            <label className="space-y-2 md:col-span-2">
              <FieldLabel required>Logo URL</FieldLabel>
              <input
                required
                type="url"
                aria-label="Logo URL"
                aria-invalid={errors.logoUrl ? 'true' : 'false'}
                {...register('logoUrl')}
                className="w-full rounded-lg border border-input bg-background px-4 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                placeholder="https://example.com/logo.png"
              />
              <FieldError message={errors.logoUrl?.message} />
            </label>

            <label className="space-y-2 md:col-span-2">
              <FieldLabel>Video URL</FieldLabel>
              <input
                type="url"
                aria-label="Video URL"
                aria-invalid={errors.videoUrl ? 'true' : 'false'}
                {...register('videoUrl')}
                className="w-full rounded-lg border border-input bg-background px-4 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                placeholder="https://www.youtube.com/watch?v=..."
              />
              <FieldError message={errors.videoUrl?.message} />
            </label>
          </div>

          <label className="block space-y-2">
            <FieldLabel required>Short Description</FieldLabel>
            <textarea
              required
              aria-label="Short Description"
              aria-invalid={errors.description ? 'true' : 'false'}
              {...register('description')}
              className="min-h-24 w-full rounded-lg border border-input bg-background px-4 py-3 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              placeholder="One sentence describing what this listing covers."
            />
            <FieldError message={errors.description?.message} />
          </label>

          <label className="block space-y-2">
            <FieldLabel required>Full Description</FieldLabel>
            <textarea
              required
              aria-label="Full Description"
              aria-invalid={errors.content ? 'true' : 'false'}
              {...register('content')}
              className="min-h-48 w-full rounded-lg border border-input bg-background px-4 py-3 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              placeholder="Markdown supported. Describe what makes this listing valuable."
            />
            <FieldError message={errors.content?.message} />
          </label>

          <div className="space-y-3">
            <span className="text-sm font-medium">FAQs</span>
            {faqFields.map((field, index) => {
              const faqError = errors.faqs?.[index]
              const watchedFaq = watchedFaqs[index]
              const questionMissing =
                Boolean(watchedFaq?.answer.trim()) && !watchedFaq?.question.trim()
              const answerMissing =
                Boolean(watchedFaq?.question.trim()) && !watchedFaq?.answer.trim()

              return (
                <div key={field.id} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_2fr_auto]">
                  <label className="space-y-1">
                    <span className="sr-only">FAQ question</span>
                    <input
                      type="text"
                      aria-invalid={faqError?.question ? 'true' : 'false'}
                      {...register(`faqs.${index}.question` as const)}
                      className="w-full rounded-lg border border-input bg-background px-4 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      placeholder="Question"
                    />
                    <FieldError
                      message={
                        faqError?.question?.message || (questionMissing ? 'Enter a question.' : '')
                      }
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="sr-only">FAQ answer</span>
                    <input
                      type="text"
                      aria-invalid={faqError?.answer ? 'true' : 'false'}
                      {...register(`faqs.${index}.answer` as const)}
                      className="w-full rounded-lg border border-input bg-background px-4 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      placeholder="Answer"
                    />
                    <FieldError
                      message={
                        faqError?.answer?.message || (answerMissing ? 'Enter an answer.' : '')
                      }
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => removeFaq(index)}
                    disabled={faqFields.length <= 1}
                    className="inline-flex h-10 items-center justify-center rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted/50"
                    aria-label="Remove FAQ"
                  >
                    x
                  </button>
                </div>
              )
            })}
            {faqFields.length < MAX_FAQS ? (
              <button
                type="button"
                onClick={() => appendFaq({ answer: '', question: '' })}
                className="text-sm text-primary underline-offset-2 hover:underline"
              >
                Add another FAQ
              </button>
            ) : null}
          </div>

          <div className="space-y-3">
            <span className="text-sm font-medium">Resource Links</span>
            {resourceLinkFields.map((field, index) => {
              const resourceLinkError = errors.resourceLinks?.[index]

              return (
                <div key={field.id} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_2fr_auto]">
                  <label className="space-y-1">
                    <span className="sr-only">Resource link label</span>
                    <input
                      type="text"
                      aria-invalid={resourceLinkError?.label ? 'true' : 'false'}
                      {...register(`resourceLinks.${index}.label` as const)}
                      className="w-full rounded-lg border border-input bg-background px-4 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      placeholder="Label"
                    />
                    <FieldError message={resourceLinkError?.label?.message} />
                  </label>
                  <label className="space-y-1">
                    <span className="sr-only">Resource link URL</span>
                    <input
                      type="url"
                      aria-invalid={resourceLinkError?.url ? 'true' : 'false'}
                      {...register(`resourceLinks.${index}.url` as const)}
                      className="w-full rounded-lg border border-input bg-background px-4 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      placeholder="https://example.com/docs"
                    />
                    <FieldError message={resourceLinkError?.url?.message} />
                  </label>
                  <button
                    type="button"
                    onClick={() => removeResourceLink(index)}
                    disabled={resourceLinkFields.length <= 1}
                    className="inline-flex h-10 items-center justify-center rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted/50"
                    aria-label="Remove link"
                  >
                    x
                  </button>
                </div>
              )
            })}
            {resourceLinkFields.length < MAX_RESOURCE_LINKS ? (
              <button
                type="button"
                onClick={() => appendResourceLink({ label: '', url: '' })}
                className="text-sm text-primary underline-offset-2 hover:underline"
              >
                Add another link
              </button>
            ) : null}
          </div>

          <div className="border border-border bg-muted/30 p-4">
            <p className="text-sm font-semibold">Badge verification is required</p>
            <p className="mt-1 text-sm text-muted-foreground">
              After saving, you will receive badge embed code. Your submission enters admin review
              only after the live badge is verified on your website.
            </p>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row">
            <button
              type="submit"
              disabled={isSubmitDisabled}
              className="inline-flex items-center justify-center rounded-none bg-foreground px-6 py-3 text-sm font-bold text-background transition-colors hover:bg-foreground/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Submit
            </button>
            <button
              type="button"
              onClick={handleReset}
              className="inline-flex items-center justify-center rounded-none border border-border px-6 py-3 text-sm font-bold transition-colors hover:bg-muted/50"
            >
              Reset
            </button>
          </div>
        </form>
      ) : null}
      <Dialog
        open={Boolean(badgeInstructions) && verificationDialogOpen}
        onOpenChange={open => {
          setVerificationDialogOpen(open)
          if (!open) setCopiedTheme(null)
        }}
      >
        <DialogContent className="max-h-[min(760px,calc(100dvh-2rem))] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Step 2 of 2 — Install and verify your badge</DialogTitle>
            <DialogDescription>
              Step 1 is complete: your submission is saved in D1. You can close this window and
              return later without losing your progress.
            </DialogDescription>
          </DialogHeader>

          {badgeInstructions ? (
            <div className="space-y-5">
              {verificationDiagnostic ? (
                <VerificationDiagnosticAlert diagnostic={verificationDiagnostic} />
              ) : null}
              <div className="rounded-md border border-border bg-muted/40 p-4">
                <ol className="list-decimal space-y-2 pl-5 text-sm text-muted-foreground">
                  <li>Copy either badge snippet below.</li>
                  <li>
                    Add the exact snippet to the HTML returned by your submitted URL. A badge added
                    only after JavaScript runs cannot be detected.
                  </li>
                  <li>Publish the change and make sure the badge link is not marked `nofollow`.</li>
                  <li>Use the verification button below to check that exact URL.</li>
                </ol>
                <p className="mt-3 break-all border-t border-border pt-3 text-sm font-medium">
                  URL checked:{' '}
                  <a
                    href={badgeInstructions.website}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline underline-offset-2"
                  >
                    {badgeInstructions.website}
                  </a>
                </p>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                {(['light', 'dark'] as const).map(theme => (
                  <div key={theme} className="space-y-3 rounded-md border border-border p-4">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-semibold capitalize">{theme} badge</span>
                      <button
                        type="button"
                        onClick={() => void handleCopyBadge(theme)}
                        className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-xs font-medium transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {copiedTheme === theme ? (
                          <Check className="size-4 text-emerald-500" />
                        ) : (
                          <Copy className="size-4" />
                        )}
                        {copiedTheme === theme ? 'Copied' : 'Copy'}
                      </button>
                    </div>
                    <img
                      src={badgeInstructions.badgePreviewPaths[theme]}
                      alt={`${theme === 'light' ? 'Light' : 'Dark'} Featured on ${
                        badgeInstructions.siteName
                      } badge`}
                      width={200}
                      height={50}
                      className="h-auto max-w-full"
                    />
                    <textarea
                      readOnly
                      value={badgeInstructions.badgeEmbeds[theme]}
                      rows={5}
                      className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 font-mono text-xs text-foreground focus:outline-none"
                      aria-label={`${theme} badge embed code`}
                    />
                  </div>
                ))}
              </div>

              <p className="text-xs text-muted-foreground">
                The badge links to the future listing URL for {badgeInstructions.name}:{' '}
                <span className="break-all font-mono">{badgeInstructions.listingUrl}</span>
              </p>
            </div>
          ) : null}

          <DialogFooter>
            <button
              type="button"
              onClick={() => setVerificationDialogOpen(false)}
              className="inline-flex items-center justify-center rounded-none border border-border px-4 py-2 text-sm font-bold transition-colors hover:bg-muted/50"
            >
              Close for now
            </button>
            {verificationState === 'verified' ? (
              <span className="inline-flex items-center gap-2 text-sm font-semibold text-emerald-700 dark:text-emerald-400">
                <Check className="size-4" />
                Badge verified — admin notified within a few minutes
              </span>
            ) : (
              <button
                type="button"
                disabled={verificationState === 'checking'}
                onClick={() => void handleVerifyBadge()}
                className="inline-flex items-center justify-center gap-2 rounded-none bg-foreground px-4 py-2 text-sm font-bold text-background transition-colors hover:bg-foreground/90 disabled:opacity-50"
              >
                {verificationState === 'checking' ? 'Checking badge…' : 'Verify installed badge'}
                <ExternalLink className="size-4" />
              </button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

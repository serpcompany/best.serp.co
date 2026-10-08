'use client'

import {
  ArrowRight,
  BadgeCheck,
  Ban,
  Check,
  ExternalLink,
  ImageIcon,
  MessageSquare,
  RefreshCw,
  TriangleAlert
} from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { Button, buttonVariants } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle
} from '@/components/ui/card'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText
} from '@/components/ui/input-group'
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from '@/components/ui/item'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { featureCopy } from '@/lib/feature-copy'
import {
  type Availability,
  descriptionLengthMessage,
  fieldErrors,
  hostOf,
  logoUrlProblem,
  newDraftSchema,
  normalizeWebsiteInput,
  type PrefillResponse,
  SUBMISSION_FIELD_LIMITS,
  type SubmissionField,
  type SubmissionSummary
} from '@/lib/submissions/contract'
import { cn } from '@/lib/utils'
import {
  clearLocalDraft,
  type LocalSubmitDraft,
  type LogoChoice,
  readLocalDraft,
  writeLocalDraft
} from './draft-storage'
import { createDraft, requestPrefill, updateDraft } from './submit-api'
import { ProductLogo, ToneAlert } from './submit-ui'

/**
 * `/submit` (#70 screen 2): one Card with the product's details. The form works signed out and
 * is kept in this browser (`draft-storage.ts`) through the email-code sign-in; signed in,
 * "Continue" saves the draft to the account and goes on to the plan choice (2b). The website
 * address is read to propose the name, short description, and logo (`/api/submissions/prefill`);
 * everything stays editable, and the category is never filled in.
 */

export interface CategoryOption {
  label: string
  slug: string
}

export interface SubmitFormProps {
  categories: readonly CategoryOption[]
  /** `?edit=<id>`: the owner's saved draft, edited in place (2b "Edit details"). */
  editing: SubmissionSummary | null
  /** `?url=`: the website to start from (the "draft expired" email's "Start again"). */
  initialUrl: string | null
  /** Accept http logo URLs (a local Worker only, for its http fixture sites). */
  allowInsecureLogos: boolean
  signedInEmail: string | null
  /** Keys this browser's draft to the account (`draft-storage.ts`); null signed out. */
  signedInUserId: string | null
}

type FilledField = 'description' | 'logo' | 'name'

type PrefillState =
  | { kind: 'idle' }
  | { kind: 'loading'; website: string }
  | { count: number; fields: string[]; host: string; kind: 'found' }
  | { code: string; host: string; kind: 'failed' }

const FIELD_LABELS: Record<SubmissionField, string> = {
  categorySlug: 'Primary category',
  content: 'Long description',
  description: 'Short description',
  logoUrl: 'Logo',
  name: 'Name',
  website: 'Website URL'
}

const FIELD_ORDER: SubmissionField[] = [
  'website',
  'name',
  'categorySlug',
  'description',
  'logoUrl',
  'content'
]

const LOGO_SPEC = 'PNG, JPG or WebP, at least 128 × 128 px, up to 1 MB'
const SIGN_IN_PATH = `/login/?callbackUrl=${encodeURIComponent('/submit/')}`

function sourceTag(source: string | undefined): string | null {
  if (!source) return null
  return source === 'site' ? 'From your site' : `From ${source}`
}

/** "Name, short description, and logo" */
function listFields(fields: string[]): string {
  if (fields.length <= 1) return fields[0] ?? ''
  return `${fields.slice(0, -1).join(', ')}${fields.length > 2 ? ',' : ''} and ${fields.at(-1)}`
}

function capitalize(value: string): string {
  return value ? `${value[0]?.toUpperCase()}${value.slice(1)}` : value
}

function prefillFailure(code: string): string {
  if (code === 'fetch_timeout') {
    return 'The site didn’t respond within 8 seconds, so nothing was filled in. Enter the details yourself, or try again.'
  }
  if (code === 'rate_limited') {
    return 'We’ve read a lot of pages for you in the last few minutes. Enter the details yourself, or try again later.'
  }
  return 'The page didn’t load, so nothing was filled in. Enter the details yourself, or try again.'
}

/** The typed address without its scheme and `www.`: `brieflow.ai/pricing`. */
function displayAddress(website: string): string {
  try {
    const url = new URL(website)
    const path = url.pathname.replace(/\/+$/u, '')
    return `${url.hostname.replace(/^www\./u, '')}${path}`
  } catch {
    return website
  }
}

/** Whether `value` looks like a complete address worth reading (a host with a dot). */
function readableWebsite(value: string): string | null {
  const website = normalizeWebsiteInput(value)
  try {
    const url = new URL(website)
    return /\.[a-z0-9-]{2,}$/iu.test(url.hostname) ? website : null
  } catch {
    return null
  }
}

export function SubmitForm({
  allowInsecureLogos,
  categories,
  editing,
  initialUrl,
  signedInEmail,
  signedInUserId
}: SubmitFormProps) {
  const router = useRouter()
  const signedIn = signedInEmail !== null
  const [website, setWebsite] = useState(editing?.website ?? '')
  const [name, setName] = useState(editing?.name ?? '')
  const [categorySlug, setCategorySlug] = useState(editing?.categorySlug ?? '')
  const [description, setDescription] = useState(editing?.description ?? '')
  const [content, setContent] = useState(editing?.content ?? '')
  const [logoChoice, setLogoChoice] = useState<LogoChoice | null>(editing ? 'url' : null)
  const [logoInput, setLogoInput] = useState(editing?.logoUrl ?? '')
  const [siteIcon, setSiteIcon] = useState<string | null>(null)
  const [socialImage, setSocialImage] = useState<string | null>(null)
  const [filled, setFilled] = useState<Partial<Record<FilledField, string>>>({})
  const [prefill, setPrefill] = useState<PrefillState>({ kind: 'idle' })
  const [availability, setAvailability] = useState<Availability | null>(null)
  const [errors, setErrors] = useState<Partial<Record<SubmissionField, string>>>({})
  const [showSummary, setShowSummary] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [restored, setRestored] = useState(editing !== null)
  const lastRead = useRef<string | null>(null)
  const prefillAbort = useRef<AbortController | null>(null)
  const saved = useRef(false)

  const logoUrl =
    logoChoice === 'site-icon'
      ? (siteIcon ?? '')
      : logoChoice === 'social-image'
        ? (socialImage ?? '')
        : logoInput.trim()

  const blocking =
    availability !== null && availability.kind !== 'available' && availability.kind !== 'invalid'

  const applyPrefill = useCallback(
    (result: Extract<NonNullable<PrefillResponse['prefill']>, { ok: true }>) => {
      // Only empty fields, or fields the last prefill filled, are replaced: never an edit.
      const next = { ...filled }
      const fields: string[] = []
      if (result.name && (!name.trim() || filled.name)) {
        setName(result.name.value)
        next.name = result.name.source
        fields.push('name')
      }
      if (result.description && (!description.trim() || filled.description)) {
        setDescription(result.description.value)
        next.description = result.description.source
        fields.push('short description')
      }
      setSiteIcon(result.siteIcon)
      setSocialImage(result.socialImage)
      if ((result.siteIcon || result.socialImage) && (logoChoice === null || filled.logo)) {
        setLogoChoice(result.siteIcon ? 'site-icon' : 'social-image')
        next.logo = 'site'
        fields.push('logo')
      }
      setFilled(next)
      setPrefill({ count: fields.length, fields, host: result.host, kind: 'found' })
    },
    [description, filled, logoChoice, name]
  )

  const readWebsite = useCallback(
    async (value: string, force = false) => {
      if (editing) return
      const target = readableWebsite(value)
      if (!target || (!force && lastRead.current === target)) return
      lastRead.current = target
      prefillAbort.current?.abort()
      const controller = new AbortController()
      prefillAbort.current = controller
      setPrefill({ kind: 'loading', website: target })
      setAvailability(null)
      const response = await requestPrefill(target, controller.signal)
      if (controller.signal.aborted) return
      if (!response.ok) {
        if (response.error.availability) setAvailability(response.error.availability)
        setPrefill({ code: response.error.code, host: hostOf(target), kind: 'failed' })
        return
      }
      const { availability: answer, prefill: result } = response.data
      setAvailability(answer)
      setErrors(current => ({
        ...current,
        website: answer.kind === 'invalid' ? answer.message : undefined
      }))
      if (!result) {
        setPrefill({ kind: 'idle' })
        return
      }
      if (!result.ok) {
        setPrefill({ code: result.code, host: result.host, kind: 'failed' })
        return
      }
      applyPrefill(result)
    },
    [applyPrefill, editing]
  )

  // Restore this browser's draft, or start from `?url=`.
  useEffect(() => {
    if (editing) return
    const local = readLocalDraft(signedInUserId)
    const fromUrl = initialUrl ? normalizeWebsiteInput(initialUrl) : null
    if (local && (!fromUrl || local.website === fromUrl)) {
      setWebsite(local.website)
      setName(local.name)
      setCategorySlug(local.categorySlug)
      setDescription(local.description)
      setContent(local.content)
      setLogoChoice(local.logoChoice)
      setLogoInput(local.logoChoice === 'url' ? local.logoUrl : '')
      setSiteIcon(local.siteIcon)
      setSocialImage(local.socialImage)
      setFilled(local.filled)
      lastRead.current = readableWebsite(local.website)
    } else if (fromUrl) {
      setWebsite(fromUrl)
      void readWebsite(fromUrl)
    }
    setRestored(true)
    // Runs once, on mount.
  }, [])

  // Keep this browser's draft current while the visitor types.
  useEffect(() => {
    if (editing || !restored || saved.current) return undefined
    const timer = window.setTimeout(() => {
      const draft: Omit<LocalSubmitDraft, 'savedAt'> = {
        categorySlug,
        content,
        description,
        filled,
        logoChoice,
        logoUrl,
        name,
        siteIcon,
        socialImage,
        website
      }
      if (website || name || description || content) writeLocalDraft(draft, signedInUserId)
    }, 250)
    return () => window.clearTimeout(timer)
  }, [
    categorySlug,
    content,
    description,
    editing,
    filled,
    logoChoice,
    logoUrl,
    name,
    restored,
    siteIcon,
    socialImage,
    website
  ])

  // Read the page shortly after a complete address is typed or pasted.
  useEffect(() => {
    if (editing || !restored) return undefined
    const target = readableWebsite(website)
    if (!target || target === lastRead.current) return undefined
    const timer = window.setTimeout(() => void readWebsite(target), 800)
    return () => window.clearTimeout(timer)
  }, [editing, readWebsite, restored, website])

  function unfill(field: FilledField) {
    setFilled(current => {
      if (!(field in current)) return current
      const { [field]: _removed, ...rest } = current
      return rest
    })
  }

  function clearError(field: SubmissionField) {
    setErrors(current => (current[field] ? { ...current, [field]: undefined } : current))
  }

  function clearFilled() {
    if (filled.name) setName('')
    if (filled.description) setDescription('')
    if (filled.logo) setLogoChoice(null)
    setFilled({})
    setPrefill({ kind: 'idle' })
  }

  function validate(): Partial<Record<SubmissionField, string>> | null {
    const parsed = newDraftSchema.safeParse({
      categorySlug,
      content,
      description,
      logoUrl,
      name,
      website: normalizeWebsiteInput(website)
    })
    const found = parsed.success ? {} : fieldErrors(parsed.error)
    // Logos are hotlinked on https pages, so the address must be https (PR #84 review 1).
    const logoProblem = logoUrl ? logoUrlProblem(logoUrl, allowInsecureLogos) : null
    if (logoProblem && !found.logoUrl) found.logoUrl = logoProblem
    return Object.keys(found).length > 0 ? found : null
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFailure(null)
    const found = validate()
    if (found) {
      setErrors(found)
      setShowSummary(true)
      return
    }
    setErrors({})
    setShowSummary(false)
    if (blocking) return
    if (!signedIn) {
      writeLocalDraft(
        {
          categorySlug,
          content,
          description,
          filled,
          logoChoice,
          logoUrl,
          name,
          siteIcon,
          socialImage,
          website: normalizeWebsiteInput(website)
        },
        null
      )
      window.location.assign(SIGN_IN_PATH)
      return
    }
    setPending(true)
    const fields = { categorySlug, content, description, logoUrl, name }
    const response = editing
      ? await updateDraft(editing.id, {
          ...fields,
          expectedContentVersion: editing.contentVersion
        })
      : await createDraft({ ...fields, website: normalizeWebsiteInput(website) })
    if (response.ok) {
      saved.current = true
      if (!editing) clearLocalDraft(signedInUserId)
      router.push(response.data.next)
      return
    }
    setPending(false)
    const { error } = response
    if (error.availability) setAvailability(error.availability)
    if (error.fields && Object.keys(error.fields).length > 0) {
      setErrors(error.fields)
      setShowSummary(true)
    } else if (!error.availability) {
      setFailure(error.error)
    }
    if (response.status === 401) window.location.assign(SIGN_IN_PATH)
  }

  const errorFields = FIELD_ORDER.filter(field => errors[field])
  const host = hostOf(normalizeWebsiteInput(website))
  const loading = prefill.kind === 'loading'
  const descriptionTooLong = description.trim().length > SUBMISSION_FIELD_LIMITS.description

  return (
    <section className="mx-auto w-full max-w-2xl px-4 py-10 md:py-14">
      <form noValidate onSubmit={onSubmit}>
        <Card>
          <CardHeader>
            <CardTitle>
              <h1 className="font-semibold text-2xl tracking-tight">Submit a product</h1>
            </CardTitle>
            <CardDescription>
              Every listing is reviewed by the SERP team. Tell us about your product first.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              {!signedIn && !editing ? (
                <ToneAlert title="Sign in when you’re ready">
                  <p>
                    Fill in the form now. When you continue, we’ll email you a 6-digit code to sign
                    in. Your draft stays in this browser.
                  </p>
                </ToneAlert>
              ) : null}
              {showSummary && errorFields.length > 0 ? (
                <ToneAlert
                  tone="destructive"
                  title={`Fix ${errorFields.length} ${errorFields.length === 1 ? 'field' : 'fields'} to continue`}
                >
                  <ul className="list-disc pl-5">
                    {errorFields.map(field => (
                      <li key={field}>{FIELD_LABELS[field]}</li>
                    ))}
                  </ul>
                </ToneAlert>
              ) : null}
              {failure ? (
                <ToneAlert tone="destructive" title="Something went wrong">
                  <p>{failure}</p>
                </ToneAlert>
              ) : null}

              <Field data-invalid={errors.website ? true : undefined}>
                <FieldLabel htmlFor="submit-website">Website URL</FieldLabel>
                <InputGroup data-disabled={editing ? true : undefined}>
                  <InputGroupInput
                    id="submit-website"
                    type="url"
                    inputMode="url"
                    autoComplete="url"
                    placeholder="https://example.com"
                    className="font-mono text-[13px]"
                    disabled={editing !== null}
                    value={website}
                    aria-invalid={errors.website ? true : undefined}
                    aria-describedby="submit-website-help"
                    onChange={event => {
                      setWebsite(event.target.value)
                      setAvailability(null)
                      clearError('website')
                    }}
                    onBlur={event => {
                      const normalized = normalizeWebsiteInput(event.target.value)
                      if (normalized !== event.target.value) setWebsite(normalized)
                      void readWebsite(normalized)
                    }}
                  />
                  {prefill.kind !== 'idle' ? (
                    <InputGroupAddon align="inline-end">
                      {prefill.kind === 'loading' ? (
                        <InputGroupText>
                          <Spinner />
                          <span className="text-xs">Reading page…</span>
                        </InputGroupText>
                      ) : prefill.kind === 'found' && prefill.count > 0 ? (
                        <InputGroupText>
                          <Check className="text-success" />
                          <span className="text-xs">Details found</span>
                        </InputGroupText>
                      ) : prefill.kind === 'failed' ? (
                        <InputGroupText>
                          <TriangleAlert className="text-warning" />
                          <span className="text-xs">Couldn’t read page</span>
                        </InputGroupText>
                      ) : null}
                    </InputGroupAddon>
                  ) : null}
                </InputGroup>
                {errors.website ? (
                  <FieldError id="submit-website-help">{errors.website}</FieldError>
                ) : prefill.kind === 'idle' && !availability ? (
                  <FieldDescription id="submit-website-help">
                    {editing
                      ? 'The website can’t be changed once the draft is saved.'
                      : 'We read the page title, description, and icon to fill in the rest. You can change everything.'}
                  </FieldDescription>
                ) : (
                  <span id="submit-website-help" className="sr-only">
                    Website address
                  </span>
                )}
              </Field>

              {availability ? (
                <AvailabilityNotice
                  address={displayAddress(normalizeWebsiteInput(website))}
                  availability={availability}
                />
              ) : null}

              <div
                className={cn(
                  'flex flex-col gap-7',
                  blocking && 'pointer-events-none select-none opacity-50'
                )}
                aria-disabled={blocking ? true : undefined}
              >
                {prefill.kind === 'found' && prefill.count > 0 ? (
                  <ToneAlert
                    tone="info"
                    title={`We filled in ${prefill.count} ${prefill.count === 1 ? 'field' : 'fields'} from ${prefill.host}`}
                    actions={
                      <Button type="button" size="sm" variant="ghost" onClick={clearFilled}>
                        Clear filled fields
                      </Button>
                    }
                  >
                    <p>
                      {capitalize(listFields(prefill.fields))}. Check each one and change anything.
                      Pick a category yourself.
                    </p>
                  </ToneAlert>
                ) : null}
                {prefill.kind === 'failed' ? (
                  <ToneAlert
                    tone="warning"
                    title={`We couldn’t read ${prefill.host}`}
                    actions={
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => void readWebsite(website, true)}
                      >
                        <RefreshCw />
                        Try again
                      </Button>
                    }
                  >
                    <p>{prefillFailure(prefill.code)}</p>
                  </ToneAlert>
                ) : null}

                <div className="grid gap-7 md:grid-cols-2">
                  <Field data-invalid={errors.name ? true : undefined}>
                    <TaggedLabel htmlFor="submit-name" tag={sourceTag(filled.name)}>
                      Name
                    </TaggedLabel>
                    {loading ? (
                      <Skeleton className="h-9 w-full" />
                    ) : (
                      <Input
                        id="submit-name"
                        placeholder="Example product"
                        maxLength={SUBMISSION_FIELD_LIMITS.name}
                        value={name}
                        aria-invalid={errors.name ? true : undefined}
                        onChange={event => {
                          setName(event.target.value)
                          unfill('name')
                          clearError('name')
                        }}
                      />
                    )}
                    {errors.name ? <FieldError>{errors.name}</FieldError> : null}
                  </Field>
                  <Field data-invalid={errors.categorySlug ? true : undefined}>
                    <FieldLabel htmlFor="submit-category">Primary category</FieldLabel>
                    <Select
                      value={categorySlug || null}
                      items={categories.map(category => ({
                        label: category.label,
                        value: category.slug
                      }))}
                      onValueChange={value => {
                        if (!value) return
                        setCategorySlug(value)
                        clearError('categorySlug')
                      }}
                    >
                      <SelectTrigger
                        id="submit-category"
                        className="w-full"
                        aria-invalid={errors.categorySlug ? true : undefined}
                      >
                        <SelectValue placeholder="Choose a category" />
                      </SelectTrigger>
                      <SelectContent alignItemWithTrigger={false} className="max-h-80">
                        {categories.map(category => (
                          <SelectItem key={category.slug} value={category.slug}>
                            {category.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {errors.categorySlug ? (
                      <FieldError>{errors.categorySlug}</FieldError>
                    ) : prefill.kind === 'found' && !categorySlug ? (
                      <FieldDescription>
                        Pick the closest match. We don’t fill this in.
                      </FieldDescription>
                    ) : null}
                  </Field>
                </div>

                <Field data-invalid={errors.description || descriptionTooLong ? true : undefined}>
                  <TaggedLabel htmlFor="submit-description" tag={sourceTag(filled.description)}>
                    Short description
                  </TaggedLabel>
                  {loading ? (
                    <Skeleton className="h-16 w-full" />
                  ) : (
                    <Textarea
                      id="submit-description"
                      placeholder="One sentence on what it does and who it is for."
                      value={description}
                      aria-invalid={errors.description || descriptionTooLong ? true : undefined}
                      onChange={event => {
                        setDescription(event.target.value)
                        unfill('description')
                        clearError('description')
                      }}
                    />
                  )}
                  <div className="flex items-start gap-3">
                    {errors.description || descriptionTooLong ? (
                      <FieldError>
                        {errors.description ?? descriptionLengthMessage(description.trim().length)}
                      </FieldError>
                    ) : (
                      <FieldDescription>Shown on cards and in search results.</FieldDescription>
                    )}
                    <span
                      className={cn(
                        'ml-auto shrink-0 text-xs tabular-nums',
                        descriptionTooLong
                          ? 'font-medium text-destructive'
                          : 'text-muted-foreground'
                      )}
                    >
                      {description.trim().length}/{SUBMISSION_FIELD_LIMITS.description}
                    </span>
                  </div>
                </Field>

                <LogoField
                  choice={logoChoice}
                  error={errors.logoUrl}
                  filled={Boolean(filled.logo)}
                  host={prefill.kind === 'found' ? prefill.host : host}
                  input={logoInput}
                  loading={loading}
                  name={name}
                  preview={logoUrl}
                  siteIcon={siteIcon}
                  socialImage={socialImage}
                  onChoice={choice => {
                    setLogoChoice(choice)
                    unfill('logo')
                    clearError('logoUrl')
                  }}
                  onInput={value => {
                    setLogoInput(value)
                    setLogoChoice('url')
                    unfill('logo')
                    clearError('logoUrl')
                  }}
                />

                <Field data-invalid={errors.content ? true : undefined}>
                  <FieldLabel htmlFor="submit-content">
                    Long description{' '}
                    <span className="font-normal text-muted-foreground">(optional)</span>
                  </FieldLabel>
                  <Textarea
                    id="submit-content"
                    className="min-h-36"
                    placeholder="Markdown supported. What makes it useful, who it is for, how it works."
                    value={content}
                    aria-invalid={errors.content ? true : undefined}
                    onChange={event => {
                      setContent(event.target.value)
                      clearError('content')
                    }}
                  />
                  {errors.content ? (
                    <FieldError>{errors.content}</FieldError>
                  ) : (
                    <FieldDescription>{featureCopy().contentHint}</FieldDescription>
                  )}
                </Field>
              </div>
            </FieldGroup>
          </CardContent>
          <CardFooter className="border-t pt-6">
            <div className="flex w-full flex-col gap-3 sm:flex-row sm:items-center">
              {signedIn ? (
                <>
                  <Button type="submit" disabled={pending || blocking}>
                    {pending ? <Spinner /> : null}
                    {editing && editing.status !== 'draft' ? 'Save changes' : 'Continue'}
                    {pending ? null : <ArrowRight />}
                  </Button>
                  <FieldDescription>
                    {editing && editing.status !== 'draft'
                      ? 'Next, back to the badge step.'
                      : 'Next, choose how to get listed.'}
                  </FieldDescription>
                </>
              ) : (
                <>
                  <Button type="submit" disabled={blocking}>
                    Sign in and continue
                  </Button>
                  <FieldDescription>
                    We’ll email you a 6-digit code. Your draft stays in this browser.
                  </FieldDescription>
                </>
              )}
            </div>
          </CardFooter>
        </Card>
      </form>
    </section>
  )
}

function TaggedLabel({
  children,
  htmlFor,
  tag
}: {
  children: ReactNode
  htmlFor: string
  tag: string | null
}) {
  return (
    <div className="flex items-center gap-2">
      <FieldLabel htmlFor={htmlFor}>{children}</FieldLabel>
      {tag ? <span className="ml-auto text-muted-foreground text-xs">{tag}</span> : null}
    </div>
  )
}

function LogoField({
  choice,
  error,
  filled,
  host,
  input,
  loading,
  name,
  onChoice,
  onInput,
  preview,
  siteIcon,
  socialImage
}: {
  choice: LogoChoice | null
  error: string | undefined
  filled: boolean
  host: string
  input: string
  loading: boolean
  name: string
  onChoice: (choice: LogoChoice) => void
  onInput: (value: string) => void
  preview: string
  siteIcon: string | null
  socialImage: string | null
}) {
  const found = Boolean(siteIcon || socialImage)
  const showInput = !found || choice === 'url'
  return (
    <Field data-invalid={error ? true : undefined}>
      <div className="flex items-center gap-2">
        <FieldLabel htmlFor="submit-logo-url">Logo</FieldLabel>
        {filled ? (
          <span className="ml-auto text-muted-foreground text-xs">From your site</span>
        ) : null}
      </div>
      {loading ? (
        <div className="flex items-center gap-4">
          <Skeleton className="size-16 rounded-lg" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-8 w-64 max-w-full" />
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          {preview ? (
            <ProductLogo name={name || host} size={64} src={preview} />
          ) : (
            <div
              className={cn(
                'grid size-16 shrink-0 place-items-center rounded-lg border border-dashed text-muted-foreground',
                error ? 'border-destructive' : 'border-input'
              )}
            >
              <ImageIcon className="size-6" aria-hidden="true" />
            </div>
          )}
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            {found ? (
              <ToggleGroup
                variant="outline"
                value={choice ? [choice] : []}
                aria-label="Logo source"
                className="w-fit"
                onValueChange={([value]: string[]) => {
                  if (value) onChoice(value as LogoChoice)
                }}
              >
                <ToggleGroupItem value="site-icon" disabled={!siteIcon} className="px-3">
                  Site icon
                </ToggleGroupItem>
                <ToggleGroupItem value="social-image" disabled={!socialImage} className="px-3">
                  Social image
                </ToggleGroupItem>
                <ToggleGroupItem value="url" className="px-3">
                  Image URL
                </ToggleGroupItem>
              </ToggleGroup>
            ) : null}
            {showInput ? (
              <Input
                id="submit-logo-url"
                type="url"
                inputMode="url"
                placeholder="https://example.com/logo.png"
                value={input}
                aria-invalid={error ? true : undefined}
                onChange={event => onInput(event.target.value)}
              />
            ) : null}
          </div>
        </div>
      )}
      {error ? (
        <FieldError>{error}</FieldError>
      ) : (
        <FieldDescription>
          {found
            ? `Found on ${host}. Use it, pick the social image, or paste a link to a square image (${LOGO_SPEC}).`
            : `Paste a link to a square image (${LOGO_SPEC}).`}
        </FieldDescription>
      )}
    </Field>
  )
}

function AvailabilityNotice({
  address,
  availability
}: {
  address: string
  availability: Availability
}) {
  if (availability.kind === 'listed') {
    const { listing } = availability
    return (
      <ToneAlert
        title={`${listing.name} is already listed on SERP`}
        actions={
          <>
            <Link href={`${listing.path}#claim`} className={buttonVariants({ size: 'sm' })}>
              <BadgeCheck />
              Claim this listing
            </Link>
            <a
              href={listing.path}
              target="_blank"
              rel="noopener"
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              View listing
              <ExternalLink />
            </a>
          </>
        }
      >
        <p>
          We match on the domain, so {address} counts as {listing.slug}. If it’s your product, claim
          the listing to manage it.
        </p>
        <div className="mt-2 w-full">
          <Item variant="outline" className="bg-background">
            <ItemMedia>
              <ProductLogo name={listing.name} size={40} src={listing.logoUrl} />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{listing.name}</ItemTitle>
              <ItemDescription>
                {listing.categoryName ? `${listing.categoryName} · ` : ''}
                {listing.path}
              </ItemDescription>
            </ItemContent>
          </Item>
        </div>
      </ToneAlert>
    )
  }
  if (availability.kind === 'pending') {
    if (availability.mine) {
      const waiting =
        availability.mine.status === 'draft'
          ? 'It’s in your account, waiting for you to choose how to get listed.'
          : availability.mine.status === 'pending_badge'
            ? 'It’s in your account, waiting for you to finish the badge step.'
            : 'It’s in your account, waiting for a reviewer.'
      return (
        <ToneAlert
          tone="info"
          title={`You already submitted ${availability.slug}`}
          actions={
            <Link href={availability.mine.nextPath} className={buttonVariants({ size: 'sm' })}>
              Open submission
              <ArrowRight />
            </Link>
          }
        >
          <p>{waiting}</p>
        </ToneAlert>
      )
    }
    return (
      <ToneAlert
        tone="warning"
        title={`${availability.slug} is already in review`}
        actions={
          <Link href="/contact/" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            <MessageSquare />
            Message us
          </Link>
        }
      >
        <p>
          Someone else submitted this domain. If {availability.slug} is yours, message us and we’ll
          sort it out.
        </p>
      </ToneAlert>
    )
  }
  if (availability.kind === 'blocked') {
    return (
      <ToneAlert
        tone="destructive"
        icon={Ban}
        title={`${availability.slug} can’t be submitted`}
        actions={
          <Link href="/contact/" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            <MessageSquare />
            Message us
          </Link>
        }
      >
        <p>
          A reviewer rejected this site as prohibited by our Terms of Service, so it can’t be
          submitted or claimed. If you think this is a mistake, message us.
        </p>
      </ToneAlert>
    )
  }
  return null
}

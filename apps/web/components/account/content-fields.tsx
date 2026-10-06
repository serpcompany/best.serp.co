'use client'

import { Field, FieldDescription, FieldError, FieldLabel } from '@serpdirectory/design-system/field'
import { Input } from '@serpdirectory/design-system/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@serpdirectory/design-system/select'
import { Textarea } from '@serpdirectory/design-system/textarea'
import { ImageIcon } from 'lucide-react'
import { ProductLogo } from '@/components/submit/submit-ui'
import { SUBMISSION_FIELD_LIMITS } from '@/lib/submissions/contract'

/**
 * The listing details of the account's edit forms (#70 screens 6 and 7) on Card + Field: name,
 * primary category, the website (read-only), short description with its counter, logo, and
 * long description. The logo is an image link, as on `/submit/` (#84, owner-approved: no
 * upload until media hosting lands).
 */

export interface ContentValue {
  categorySlug: string
  content: string
  description: string
  logoUrl: string
  name: string
}

export type ContentErrors = Partial<Record<keyof ContentValue, string>>

export interface CategoryChoice {
  label: string
  slug: string
}

const LOGO_SPEC = 'PNG, JPG, SVG or WebP, at least 128 × 128 px, up to 1 MB'

export function contentErrors(value: ContentValue, nameEditable: boolean): ContentErrors {
  const errors: ContentErrors = {}
  if (nameEditable && !value.name.trim()) errors.name = 'Enter the product name.'
  if (!value.categorySlug) errors.categorySlug = 'Choose a primary category.'
  const description = value.description.trim()
  if (!description) errors.description = 'Add a short description.'
  else if (description.length > SUBMISSION_FIELD_LIMITS.description) {
    errors.description = `Keep it to ${SUBMISSION_FIELD_LIMITS.description} characters or fewer. It’s ${description.length} now.`
  }
  if (!value.logoUrl.trim()) errors.logoUrl = 'Add a logo. Paste a link to an image.'
  if (value.content.trim().length > SUBMISSION_FIELD_LIMITS.content) {
    errors.content = 'Keep the long description to 5,000 characters or fewer.'
  }
  return errors
}

export function ContentFields({
  categories,
  errors,
  idPrefix,
  nameEditable,
  nameNote,
  onChange,
  original,
  tallContent = false,
  value,
  website
}: {
  categories: readonly CategoryChoice[]
  errors: ContentErrors
  idPrefix: string
  nameEditable: boolean
  nameNote?: string
  onChange: (value: ContentValue) => void
  /** The saved values, to tag a changed short description "Edited". */
  original: ContentValue
  tallContent?: boolean
  value: ContentValue
  /** Shown read-only with a note, when given. */
  website?: { note: string; url: string }
}) {
  const set = (change: Partial<ContentValue>) => onChange({ ...value, ...change })
  const id = (name: string) => `${idPrefix}-${name}`
  const descriptionLength = value.description.trim().length
  return (
    <>
      <div className="grid gap-7 @md/main:grid-cols-2">
        <Field data-invalid={errors.name ? true : undefined}>
          <FieldLabel htmlFor={id('name')}>Name</FieldLabel>
          <Input
            id={id('name')}
            disabled={!nameEditable}
            maxLength={SUBMISSION_FIELD_LIMITS.name}
            value={value.name}
            aria-invalid={errors.name ? true : undefined}
            onChange={event => set({ name: event.target.value })}
          />
          {errors.name ? (
            <FieldError>{errors.name}</FieldError>
          ) : nameNote ? (
            <FieldDescription>{nameNote}</FieldDescription>
          ) : null}
        </Field>
        <Field data-invalid={errors.categorySlug ? true : undefined}>
          <FieldLabel htmlFor={id('category')}>Primary category</FieldLabel>
          <Select value={value.categorySlug} onValueChange={categorySlug => set({ categorySlug })}>
            <SelectTrigger
              id={id('category')}
              className="w-full"
              aria-invalid={errors.categorySlug ? true : undefined}
            >
              <SelectValue placeholder="Choose a category" />
            </SelectTrigger>
            <SelectContent>
              {categories.map(category => (
                <SelectItem key={category.slug} value={category.slug}>
                  {category.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {errors.categorySlug ? <FieldError>{errors.categorySlug}</FieldError> : null}
        </Field>
      </div>
      {website ? (
        <Field>
          <FieldLabel htmlFor={id('website')}>Website URL</FieldLabel>
          <Input
            id={id('website')}
            className="font-mono text-[13px]"
            disabled
            value={website.url}
          />
          <FieldDescription>{website.note}</FieldDescription>
        </Field>
      ) : null}
      <Field data-invalid={errors.description ? true : undefined}>
        <div className="flex items-center gap-2">
          <FieldLabel htmlFor={id('description')}>Short description</FieldLabel>
          {value.description.trim() !== original.description.trim() ? (
            <span className="ml-auto text-xs text-muted-foreground">Edited</span>
          ) : null}
        </div>
        <Textarea
          id={id('description')}
          value={value.description}
          aria-invalid={errors.description ? true : undefined}
          onChange={event => set({ description: event.target.value })}
        />
        <div className="flex items-start gap-4">
          {errors.description ? <FieldError>{errors.description}</FieldError> : null}
          <span className="ml-auto text-xs tabular-nums text-muted-foreground">
            {descriptionLength}/{SUBMISSION_FIELD_LIMITS.description}
          </span>
        </div>
      </Field>
      <Field data-invalid={errors.logoUrl ? true : undefined}>
        <FieldLabel htmlFor={id('logo')}>Logo</FieldLabel>
        <div className="flex flex-col gap-4 @sm/main:flex-row @sm/main:items-center">
          {value.logoUrl.trim() ? (
            <ProductLogo name={value.name} size={64} src={value.logoUrl.trim()} />
          ) : (
            <div className="grid size-16 shrink-0 place-items-center rounded-lg border border-dashed border-input text-muted-foreground">
              <ImageIcon className="size-6" aria-hidden="true" />
            </div>
          )}
          <Input
            id={id('logo')}
            inputMode="url"
            placeholder="https://example.com/logo.png"
            value={value.logoUrl}
            aria-invalid={errors.logoUrl ? true : undefined}
            onChange={event => set({ logoUrl: event.target.value })}
          />
        </div>
        {errors.logoUrl ? (
          <FieldError>{errors.logoUrl}</FieldError>
        ) : (
          <FieldDescription>Paste a link to a square image ({LOGO_SPEC}).</FieldDescription>
        )}
      </Field>
      <Field data-invalid={errors.content ? true : undefined}>
        <FieldLabel htmlFor={id('content')}>
          Long description <span className="font-normal text-muted-foreground">(optional)</span>
        </FieldLabel>
        <Textarea
          id={id('content')}
          className={tallContent ? 'min-h-36' : undefined}
          value={value.content}
          aria-invalid={errors.content ? true : undefined}
          onChange={event => set({ content: event.target.value })}
        />
        {errors.content ? (
          <FieldError>{errors.content}</FieldError>
        ) : tallContent ? (
          <FieldDescription>Markdown supported.</FieldDescription>
        ) : null}
      </Field>
    </>
  )
}

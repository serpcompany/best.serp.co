'use client'

import { useRouter } from 'next/navigation'
import { type ReactNode, useId, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
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
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { slugify, TAXONOMY_LIMITS } from '@/lib/admin/taxonomy-fields'
import { adminRequest } from './api'

/**
 * The taxonomy forms (#405): a category (hub), a tag, and a best page, each a stock shadcn `Card`
 * with `Field`s, as the listing page's Details card. Each creates (`mode="create"`) or edits one;
 * an edit that changes the slug renames it, and its old URL redirects to the new one. A create
 * form takes `initial` values, so a later screen (#406, a submitter's suggested category) can
 * open it prefilled, and `onSaved`, which replaces the default (reset and refresh) after a save.
 */

/** A category, as the select lists it. */
export interface CategoryChoice {
  name: string
  slug: string
}

/** An active tag with its hub, as the best page form's tag select groups it. */
export interface TagChoice {
  category: string
  categoryName: string
  name: string
  slug: string
}

export interface CategoryValues {
  description: string
  name: string
  order: number
  slug: string
}

export interface TagValues {
  category: string
  description: string
  name: string
  slug: string
}

export interface BestPageValues {
  intro: string
  keyword: string
  slug: string
  tag: string
  title: string
}

type Mode = 'create' | 'edit'

const SAVE_NOTE = 'Saves to production and is logged under your name.'

/**
 * The form's state and its save: a create posts to `base`, an edit to `<base>/<slug>/update`
 * with the values it opened with as `expected`. While the slug hasn't been typed, a create keeps
 * it in step with the name (or keyword).
 */
function useTaxonomyForm<V extends { slug: string }>(input: {
  base: string
  editPath: (slug: string) => string
  empty: V
  initial?: Partial<V>
  mode: Mode
  nameOf: (values: V) => string
  onSaved?: (slug: string) => void
  updateBody: (values: V, expected: V) => unknown
}) {
  const router = useRouter()
  const start = { ...input.empty, ...input.initial }
  const [values, setValues] = useState<V>(start)
  const [slugTyped, setSlugTyped] = useState(input.mode === 'edit' || Boolean(input.initial?.slug))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const change = (next: Partial<V>, sluggedFrom?: string) => {
    setValues(current => ({
      ...current,
      ...next,
      ...(sluggedFrom !== undefined && !slugTyped ? { slug: slugify(sluggedFrom) } : {})
    }))
    setError(null)
  }
  const changeSlug = (slug: string) => {
    setSlugTyped(true)
    change({ slug } as Partial<V>)
  }

  const save = async () => {
    setBusy(true)
    setError(null)
    const result =
      input.mode === 'create'
        ? await adminRequest<{ slug: string }>(input.base, values)
        : await adminRequest<{ slug: string }>(
            `${input.base}/${encodeURIComponent(start.slug)}/update`,
            input.updateBody(values, start)
          )
    setBusy(false)
    if (!result.ok) {
      setError(result.message)
      toast.error(result.message)
      return
    }
    const name = input.nameOf(values).trim()
    toast.success(
      result.replayed
        ? 'Already done. Nothing changed.'
        : input.mode === 'create'
          ? `${name} was added.`
          : 'Saved.'
    )
    if (input.onSaved) {
      input.onSaved(result.slug)
      return
    }
    if (input.mode === 'create') {
      setValues(input.empty)
      setSlugTyped(false)
      router.refresh()
    } else if (result.slug !== start.slug) {
      router.replace(input.editPath(result.slug))
    } else {
      router.refresh()
    }
  }

  return { busy, change, changeSlug, error, save, values }
}

function FormCard({
  busy,
  children,
  description,
  error,
  formId,
  onSubmit,
  submitLabel,
  title
}: {
  busy: boolean
  children: ReactNode
  description?: string
  error: string | null
  formId: string
  onSubmit: () => void
  submitLabel: string
  title: string
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent>
        <form
          id={formId}
          onSubmit={event => {
            event.preventDefault()
            onSubmit()
          }}
        >
          <FieldGroup>
            {children}
            {error ? <FieldError>{error}</FieldError> : null}
          </FieldGroup>
        </form>
      </CardContent>
      <CardFooter className="border-t pt-6">
        <div className="flex w-full flex-col gap-3 sm:flex-row sm:items-center">
          <Button type="submit" form={formId} disabled={busy}>
            {submitLabel}
          </Button>
          <FieldDescription>{SAVE_NOTE}</FieldDescription>
        </div>
      </CardFooter>
    </Card>
  )
}

function SlugField({
  id,
  mode,
  onChange,
  value
}: {
  id: string
  mode: Mode
  onChange: (slug: string) => void
  value: string
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>Slug</FieldLabel>
      <Input
        id={id}
        className="font-mono text-[13px]"
        maxLength={TAXONOMY_LIMITS.slug}
        value={value}
        onChange={event => onChange(event.target.value)}
      />
      {mode === 'edit' ? (
        <FieldDescription>Changing it redirects the old URL to the new one.</FieldDescription>
      ) : null}
    </Field>
  )
}

export function CategoryForm({
  initial,
  mode,
  onSaved
}: {
  initial?: Partial<CategoryValues>
  mode: Mode
  onSaved?: (slug: string) => void
}) {
  const id = useId()
  const form = useTaxonomyForm<CategoryValues>({
    base: '/api/admin/categories',
    editPath: slug => `/admin/categories/${encodeURIComponent(slug)}/`,
    empty: { description: '', name: '', order: 0, slug: '' },
    initial,
    mode,
    nameOf: values => values.name,
    onSaved,
    updateBody: (category, expected) => ({ category, expected })
  })
  const { values } = form
  return (
    <FormCard
      busy={form.busy}
      description={
        mode === 'create' ? 'Its page shows once a live listing is filed under it.' : undefined
      }
      error={form.error}
      formId={`${id}-form`}
      onSubmit={() => void form.save()}
      submitLabel={mode === 'create' ? 'Add category' : 'Save changes'}
      title={mode === 'create' ? 'Add a category' : 'Details'}
    >
      <div className="grid gap-7 md:grid-cols-2">
        <Field>
          <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
          <Input
            id={`${id}-name`}
            maxLength={TAXONOMY_LIMITS.name}
            value={values.name}
            onChange={event => form.change({ name: event.target.value }, event.target.value)}
          />
        </Field>
        <SlugField id={`${id}-slug`} mode={mode} value={values.slug} onChange={form.changeSlug} />
      </div>
      <Field>
        <FieldLabel htmlFor={`${id}-description`}>Description</FieldLabel>
        <Textarea
          id={`${id}-description`}
          maxLength={TAXONOMY_LIMITS.description}
          value={values.description}
          onChange={event => form.change({ description: event.target.value })}
        />
      </Field>
      <Field className="md:max-w-40">
        <FieldLabel htmlFor={`${id}-order`}>Order</FieldLabel>
        <Input
          id={`${id}-order`}
          type="number"
          min={0}
          max={TAXONOMY_LIMITS.order}
          step={1}
          value={values.order}
          onChange={event => {
            const order = event.target.valueAsNumber
            form.change({ order: Number.isNaN(order) ? 0 : order })
          }}
        />
      </Field>
    </FormCard>
  )
}

function CategorySelect({
  categories,
  id,
  onChange,
  value
}: {
  categories: readonly CategoryChoice[]
  id: string
  onChange: (slug: string) => void
  value: string
}) {
  return (
    <Select
      value={value || null}
      onValueChange={next => {
        if (next) onChange(next)
      }}
      items={categories.map(option => ({ label: option.name, value: option.slug }))}
    >
      <SelectTrigger id={id} className="w-full">
        <SelectValue placeholder="Choose a category" />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false}>
        {categories.map(option => (
          <SelectItem key={option.slug} value={option.slug}>
            {option.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function TagForm({
  categories,
  initial,
  mode,
  onSaved
}: {
  /** The active categories, one of which is the tag's hub. */
  categories: readonly CategoryChoice[]
  initial?: Partial<TagValues>
  mode: Mode
  onSaved?: (slug: string) => void
}) {
  const id = useId()
  const form = useTaxonomyForm<TagValues>({
    base: '/api/admin/tags',
    editPath: slug => `/admin/tags/${encodeURIComponent(slug)}/`,
    empty: { category: '', description: '', name: '', slug: '' },
    initial,
    mode,
    nameOf: values => values.name,
    onSaved,
    updateBody: (tag, expected) => ({ expected, tag })
  })
  const { values } = form
  return (
    <FormCard
      busy={form.busy}
      description={mode === 'create' ? 'Its page shows once a live listing carries it.' : undefined}
      error={form.error}
      formId={`${id}-form`}
      onSubmit={() => void form.save()}
      submitLabel={mode === 'create' ? 'Add tag' : 'Save changes'}
      title={mode === 'create' ? 'Add a tag' : 'Details'}
    >
      <div className="grid gap-7 md:grid-cols-2">
        <Field>
          <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
          <Input
            id={`${id}-name`}
            maxLength={TAXONOMY_LIMITS.name}
            value={values.name}
            onChange={event => form.change({ name: event.target.value }, event.target.value)}
          />
        </Field>
        <SlugField id={`${id}-slug`} mode={mode} value={values.slug} onChange={form.changeSlug} />
      </div>
      <Field>
        <FieldLabel htmlFor={`${id}-category`}>Category</FieldLabel>
        <CategorySelect
          categories={categories}
          id={`${id}-category`}
          value={values.category}
          onChange={category => form.change({ category })}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${id}-description`}>Description</FieldLabel>
        <Textarea
          id={`${id}-description`}
          maxLength={TAXONOMY_LIMITS.description}
          value={values.description}
          onChange={event => form.change({ description: event.target.value })}
        />
      </Field>
    </FormCard>
  )
}

export function BestPageForm({
  initial,
  mode,
  onSaved,
  tags
}: {
  initial?: Partial<BestPageValues>
  mode: Mode
  onSaved?: (slug: string) => void
  /** The active tags, grouped by hub; the page ranks one. */
  tags: readonly TagChoice[]
}) {
  const id = useId()
  const form = useTaxonomyForm<BestPageValues>({
    base: '/api/admin/best-pages',
    editPath: slug => `/admin/best-pages/${encodeURIComponent(slug)}/`,
    empty: { intro: '', keyword: '', slug: '', tag: '', title: '' },
    initial,
    mode,
    nameOf: values => values.title,
    onSaved,
    updateBody: (page, expected) => ({ expected, page })
  })
  const { values } = form
  const groups = [...new Set(tags.map(tag => tag.category))].map(category => ({
    category,
    items: tags.filter(tag => tag.category === category)
  }))
  return (
    <FormCard
      busy={form.busy}
      description={mode === 'create' ? 'It shows once a live listing carries its tag.' : undefined}
      error={form.error}
      formId={`${id}-form`}
      onSubmit={() => void form.save()}
      submitLabel={mode === 'create' ? 'Add best page' : 'Save changes'}
      title={mode === 'create' ? 'Add a best page' : 'Details'}
    >
      <div className="grid gap-7 md:grid-cols-2">
        <Field>
          <FieldLabel htmlFor={`${id}-keyword`}>Keyword</FieldLabel>
          <Input
            id={`${id}-keyword`}
            maxLength={TAXONOMY_LIMITS.keyword}
            value={values.keyword}
            onChange={event => form.change({ keyword: event.target.value }, event.target.value)}
          />
        </Field>
        <SlugField id={`${id}-slug`} mode={mode} value={values.slug} onChange={form.changeSlug} />
      </div>
      <div className="grid gap-7 md:grid-cols-2">
        <Field>
          <FieldLabel htmlFor={`${id}-title`}>Title</FieldLabel>
          <Input
            id={`${id}-title`}
            maxLength={TAXONOMY_LIMITS.title}
            value={values.title}
            onChange={event => form.change({ title: event.target.value })}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-tag`}>Tag</FieldLabel>
          <Select
            value={values.tag || null}
            onValueChange={next => {
              if (next) form.change({ tag: next })
            }}
            items={tags.map(tag => ({ label: tag.name, value: tag.slug }))}
          >
            <SelectTrigger id={`${id}-tag`} className="w-full">
              <SelectValue placeholder="Choose a tag" />
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              {groups.map(group => (
                <SelectGroup key={group.category}>
                  <SelectLabel>{group.items[0]?.categoryName}</SelectLabel>
                  {group.items.map(tag => (
                    <SelectItem key={tag.slug} value={tag.slug}>
                      {tag.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
      <Field>
        <FieldLabel htmlFor={`${id}-intro`}>Intro</FieldLabel>
        <Textarea
          id={`${id}-intro`}
          maxLength={TAXONOMY_LIMITS.intro}
          value={values.intro}
          onChange={event => form.change({ intro: event.target.value })}
        />
      </Field>
    </FormCard>
  )
}

'use client'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  FieldDescription,
  FieldError,
  FieldLegend,
  FieldSet
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { Textarea } from '@/components/ui/textarea'
import { Plus, X } from 'lucide-react'
import { ACCOUNT_EXTRAS_LIMITS, type ExtrasInput, linkUrlProblem } from '@/lib/account/contract'

/**
 * The FAQs and Links fieldsets of #70 screen 7 (FieldSet with Item rows): each FAQ is a question
 * and an answer, each link a label and an https URL, five of each at most. New rows are marked
 * "New" until saved. Shared by the live-listing edit and the in-review submission (screen 6).
 */

export interface FaqRow {
  answer: string
  isNew: boolean
  key: string
  question: string
}

export interface LinkRow {
  isNew: boolean
  key: string
  label: string
  url: string
}

export interface ExtrasValue {
  faqs: FaqRow[]
  links: LinkRow[]
}

let nextKey = 0
function key(): string {
  nextKey += 1
  return `row-${nextKey}`
}

export function extrasValue(extras: {
  faqs: ReadonlyArray<{ answer: string; question: string }>
  resourceLinks: ReadonlyArray<{ label: string; url: string }>
}): ExtrasValue {
  return {
    faqs: extras.faqs.map(faq => ({ ...faq, isNew: false, key: key() })),
    links: extras.resourceLinks.map(link => ({ ...link, isNew: false, key: key() }))
  }
}

export function extrasInput(value: ExtrasValue): ExtrasInput {
  return {
    faqs: value.faqs.map(({ answer, question }) => ({ answer, question })),
    resourceLinks: value.links.map(({ label, url }) => ({ label, url }))
  }
}

export interface ExtrasErrors {
  faqs: Record<string, string>
  links: Record<string, string>
}

/** The problems the form shows, per row; empty when it may be sent. */
export function extrasErrors(value: ExtrasValue): ExtrasErrors {
  const errors: ExtrasErrors = { faqs: {}, links: {} }
  for (const faq of value.faqs) {
    if (!faq.question.trim() || !faq.answer.trim()) {
      errors.faqs[faq.key] = 'Add a question and its answer, or remove this FAQ.'
    }
  }
  for (const link of value.links) {
    if (!link.label.trim()) errors.links[link.key] = 'Add a label, or remove this link.'
    else {
      const problem = linkUrlProblem(link.url)
      if (problem) errors.links[link.key] = problem
    }
  }
  return errors
}

export function hasExtrasErrors(errors: ExtrasErrors): boolean {
  return Object.keys(errors.faqs).length > 0 || Object.keys(errors.links).length > 0
}

export function ExtrasEditor({
  errors,
  faqsHint,
  onChange,
  value
}: {
  /** Shown after a submit attempt. */
  errors: ExtrasErrors | null
  /** Under "FAQs": where they show (`featureCopy().faqsHint`, flagged until #105). */
  faqsHint: string
  onChange: (value: ExtrasValue) => void
  value: ExtrasValue
}) {
  const setFaq = (rowKey: string, change: Partial<FaqRow>) =>
    onChange({
      ...value,
      faqs: value.faqs.map(faq => (faq.key === rowKey ? { ...faq, ...change } : faq))
    })
  const setLink = (rowKey: string, change: Partial<LinkRow>) =>
    onChange({
      ...value,
      links: value.links.map(link => (link.key === rowKey ? { ...link, ...change } : link))
    })

  return (
    <>
      <FieldSet className="gap-4">
        <div>
          <FieldLegend className="mb-1 text-base">FAQs</FieldLegend>
          <FieldDescription>{faqsHint}</FieldDescription>
        </div>
        {value.faqs.map((faq, index) => {
          const error = errors?.faqs[faq.key]
          return (
            <div
              key={faq.key}
              data-slot="item"
              className={cn(
                'flex items-start gap-3 rounded-md border p-4',
                faq.isNew ? 'border-primary/40 bg-primary/5 dark:bg-primary/10' : 'border-border'
              )}
            >
              <div className="flex min-w-0 flex-1 flex-col gap-3">
                {faq.isNew ? (
                  <Badge variant="secondary" className="w-fit">
                    New
                  </Badge>
                ) : null}
                <Input
                  aria-label={`Question ${index + 1}`}
                  aria-invalid={error && !faq.question.trim() ? true : undefined}
                  maxLength={ACCOUNT_EXTRAS_LIMITS.faqQuestion}
                  placeholder="Question"
                  value={faq.question}
                  onChange={event => setFaq(faq.key, { question: event.target.value })}
                />
                <Textarea
                  aria-label={`Answer ${index + 1}`}
                  aria-invalid={error && !faq.answer.trim() ? true : undefined}
                  maxLength={ACCOUNT_EXTRAS_LIMITS.faqAnswer}
                  placeholder="Answer"
                  value={faq.answer}
                  onChange={event => setFaq(faq.key, { answer: event.target.value })}
                />
                {error ? <FieldError>{error}</FieldError> : null}
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8 text-muted-foreground"
                onClick={() =>
                  onChange({ ...value, faqs: value.faqs.filter(item => item.key !== faq.key) })
                }
              >
                <X />
                <span className="sr-only">Remove FAQ {index + 1}</span>
              </Button>
            </div>
          )
        })}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-fit"
          disabled={value.faqs.length >= ACCOUNT_EXTRAS_LIMITS.items}
          onClick={() =>
            onChange({
              ...value,
              faqs: [...value.faqs, { answer: '', isNew: true, key: key(), question: '' }]
            })
          }
        >
          <Plus />
          Add FAQ
        </Button>
      </FieldSet>
      <FieldSet className="gap-4">
        <div>
          <FieldLegend className="mb-1 text-base">Links</FieldLegend>
          <FieldDescription>Docs, pricing, changelog, socials.</FieldDescription>
        </div>
        {value.links.map((link, index) => {
          const error = errors?.links[link.key]
          return (
            <div key={link.key} className="flex flex-col gap-2">
              <div className="grid gap-2 @sm/main:grid-cols-[minmax(0,1fr)_2fr_auto]">
                <Input
                  aria-label={`Link ${index + 1} label`}
                  aria-invalid={error && !link.label.trim() ? true : undefined}
                  maxLength={ACCOUNT_EXTRAS_LIMITS.linkLabel}
                  placeholder="Label"
                  value={link.label}
                  onChange={event => setLink(link.key, { label: event.target.value })}
                />
                <Input
                  aria-label={`Link ${index + 1} URL`}
                  aria-invalid={error && link.label.trim() ? true : undefined}
                  className="font-mono text-[13px]"
                  inputMode="url"
                  maxLength={ACCOUNT_EXTRAS_LIMITS.linkUrl}
                  placeholder="https://"
                  value={link.url}
                  onChange={event => setLink(link.key, { url: event.target.value })}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground"
                  onClick={() =>
                    onChange({ ...value, links: value.links.filter(item => item.key !== link.key) })
                  }
                >
                  <X />
                  <span className="sr-only">Remove link {index + 1}</span>
                </Button>
              </div>
              {error ? <FieldError>{error}</FieldError> : null}
            </div>
          )
        })}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-fit"
          disabled={value.links.length >= ACCOUNT_EXTRAS_LIMITS.items}
          onClick={() =>
            onChange({
              ...value,
              links: [...value.links, { isNew: true, key: key(), label: '', url: '' }]
            })
          }
        >
          <Plus />
          Add link
        </Button>
      </FieldSet>
    </>
  )
}

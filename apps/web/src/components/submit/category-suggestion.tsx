'use client'

import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { CATEGORY_SUGGESTION_FIELD_LIMITS } from '@/lib/submissions/contract'

/**
 * "Can't find a category? Suggest one" (#406): an optional short name and, once there is one, an
 * optional note, under the category and tags pickers of `/submit` and the owner's listing edit.
 * The suggestion goes to the reviewer; the primary category is still required.
 */
export function CategorySuggestionFields({
  disabled = false,
  errors = {},
  id,
  name,
  note,
  onChange
}: {
  disabled?: boolean
  errors?: { name?: string; note?: string }
  /** The prefix of the two inputs' ids. */
  id: string
  name: string
  note: string
  onChange: (next: { name: string; note: string }) => void
}) {
  return (
    <>
      <Field data-invalid={errors.name ? true : undefined}>
        <FieldLabel htmlFor={`${id}-name`}>
          Can’t find a category? Suggest one{' '}
          <span className="font-normal text-muted-foreground">(optional)</span>
        </FieldLabel>
        <Input
          id={`${id}-name`}
          disabled={disabled}
          maxLength={CATEGORY_SUGGESTION_FIELD_LIMITS.name}
          value={name}
          aria-invalid={errors.name ? true : undefined}
          onChange={event => onChange({ name: event.target.value, note })}
        />
        {errors.name ? (
          <FieldError>{errors.name}</FieldError>
        ) : (
          <FieldDescription>
            Give it a short name. You still choose the closest category above.
          </FieldDescription>
        )}
      </Field>
      {name.trim() || note ? (
        <Field data-invalid={errors.note ? true : undefined}>
          <FieldLabel htmlFor={`${id}-note`}>
            Note <span className="font-normal text-muted-foreground">(optional)</span>
          </FieldLabel>
          <Textarea
            id={`${id}-note`}
            disabled={disabled}
            maxLength={CATEGORY_SUGGESTION_FIELD_LIMITS.note}
            value={note}
            aria-invalid={errors.note ? true : undefined}
            onChange={event => onChange({ name, note: event.target.value })}
          />
          {errors.note ? <FieldError>{errors.note}</FieldError> : null}
        </Field>
      ) : null}
    </>
  )
}

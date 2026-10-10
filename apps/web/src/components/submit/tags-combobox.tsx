'use client'

import { useMemo } from 'react'
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxCollection,
  ComboboxContent,
  ComboboxGroup,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  ComboboxValue,
  useComboboxAnchor
} from '@/components/ui/combobox'

/**
 * The Tags field (#341, design 4.3 and 4.4): stock shadcn Combobox with multiple selection, its
 * active tags grouped by hub, and no free text. `/submit`, the owner's listing edit, the admin
 * review's edit and the admin listing page use it.
 */

/** An active tag and its hub. */
export interface TagChoice {
  category: string
  categoryName: string
  label: string
  slug: string
}

interface TagGroup {
  category: string
  items: TagChoice[]
  /** The hub's name, the group's label. */
  value: string
}

export function TagsCombobox({
  choices,
  disabled = false,
  firstCategory,
  id,
  invalid = false,
  max,
  onValueChange,
  value
}: {
  choices: readonly TagChoice[]
  disabled?: boolean
  /** The chosen hub, whose tags are listed first. */
  firstCategory?: string
  /** The input's id, for the field's label. */
  id: string
  invalid?: boolean
  /** How many may be chosen; the other tags are disabled once that many are. */
  max?: number
  onValueChange: (slugs: string[]) => void
  /** The chosen slugs, in order. */
  value: readonly string[]
}) {
  const anchor = useComboboxAnchor()
  const groups = useMemo(() => {
    const byHub = new Map<string, TagGroup>()
    for (const choice of choices) {
      const group = byHub.get(choice.category) ?? {
        category: choice.category,
        items: [],
        value: choice.categoryName
      }
      group.items.push(choice)
      byHub.set(choice.category, group)
    }
    const all = [...byHub.values()]
    return [
      ...all.filter(group => group.category === firstCategory),
      ...all.filter(group => group.category !== firstCategory)
    ]
  }, [choices, firstCategory])
  const bySlug = useMemo(() => new Map(choices.map(choice => [choice.slug, choice])), [choices])
  // A chosen tag that is no longer offered (retired since) still shows as its slug.
  const selected = value.map(
    slug => bySlug.get(slug) ?? { category: '', categoryName: '', label: slug, slug }
  )
  const full = max !== undefined && value.length >= max

  return (
    <Combobox
      multiple
      autoHighlight
      disabled={disabled}
      items={groups}
      value={selected}
      onValueChange={next => onValueChange(next.map(choice => choice.slug))}
      isItemEqualToValue={(item, current) => item.slug === current.slug}
      itemToStringLabel={item => item.label}
      itemToStringValue={item => item.slug}
    >
      <ComboboxChips ref={anchor} className="w-full">
        <ComboboxValue>
          {(chosen: TagChoice[]) => (
            <>
              {chosen.map(choice => (
                <ComboboxChip key={choice.slug}>{choice.label}</ComboboxChip>
              ))}
              <ComboboxChipsInput id={id} aria-invalid={invalid || undefined} />
            </>
          )}
        </ComboboxValue>
      </ComboboxChips>
      <ComboboxContent anchor={anchor}>
        <ComboboxList>
          {(group: TagGroup) => (
            <ComboboxGroup key={group.category} items={group.items}>
              <ComboboxLabel>{group.value}</ComboboxLabel>
              <ComboboxCollection>
                {(item: TagChoice) => (
                  <ComboboxItem
                    key={item.slug}
                    value={item}
                    disabled={full && !value.includes(item.slug)}
                  >
                    {item.label}
                  </ComboboxItem>
                )}
              </ComboboxCollection>
            </ComboboxGroup>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}

import { Search } from 'lucide-react'
import type { ComponentProps } from 'react'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput
} from '@/components/ui/input-group'
import { cn } from '@/lib/utils'

type SearchFieldProps = ComponentProps<typeof InputGroupInput> & {
  groupClassName?: string
  /** In a form, makes the icon a submit button with this name, so clicking it searches too. */
  submitLabel?: string
}

/** A search input with a leading icon (serplists' `SearchField`, #257). */
export function SearchField({ groupClassName, submitLabel, ...props }: SearchFieldProps) {
  return (
    <InputGroup className={cn('h-10 bg-background', groupClassName)} data-slot="search-field">
      <InputGroupInput type="search" {...props} />
      <InputGroupAddon>
        {submitLabel ? (
          <InputGroupButton type="submit" size="icon-xs" aria-label={submitLabel}>
            <Search />
          </InputGroupButton>
        ) : (
          <Search />
        )}
      </InputGroupAddon>
    </InputGroup>
  )
}

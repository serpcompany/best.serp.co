import { Search } from 'lucide-react'
import type { ComponentProps } from 'react'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { cn } from '@/lib/utils'

type SearchFieldProps = ComponentProps<typeof InputGroupInput> & {
  groupClassName?: string
}

/** A search input with a leading icon (serplists' `SearchField`, #257). */
export function SearchField({ groupClassName, ...props }: SearchFieldProps) {
  return (
    <InputGroup className={cn('h-10 bg-background', groupClassName)} data-slot="search-field">
      <InputGroupInput type="search" {...props} />
      <InputGroupAddon>
        <Search />
      </InputGroupAddon>
    </InputGroup>
  )
}

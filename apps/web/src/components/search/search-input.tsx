'use client'

import { Input } from '@serpdirectory/design-system/input'
import { cn } from '@serpdirectory/design-system/lib/utils'
import { Search } from 'lucide-react'
import * as React from 'react'

type SearchInputProps = Omit<React.ComponentProps<'input'>, 'type'> & {
  searchButtonLabel?: string
  searchButtonClassName?: string
  searchIconClassName?: string
}

export const SearchInput = React.forwardRef<HTMLInputElement, SearchInputProps>(
  (
    {
      className,
      name = 'q',
      autoComplete = 'off',
      'aria-label': ariaLabel = 'Search',
      searchButtonLabel = 'Search',
      searchButtonClassName,
      searchIconClassName,
      ...props
    },
    ref
  ) => (
    <>
      <Input
        ref={ref}
        type="text"
        name={name}
        autoComplete={autoComplete}
        aria-label={ariaLabel}
        className={cn(
          'block h-auto w-full rounded-lg border border-input bg-background px-4 py-2 text-sm shadow-none ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
          className
        )}
        {...props}
      />
      <button
        type="submit"
        className={cn(
          'absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground hover:text-foreground',
          searchButtonClassName
        )}
        aria-label={searchButtonLabel}
      >
        <Search className={cn('h-4 w-4', searchIconClassName)} />
      </button>
    </>
  )
)

SearchInput.displayName = 'SearchInput'

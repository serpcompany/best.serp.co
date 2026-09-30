'use client'

import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'
import { Command, CommandEmpty, CommandGroup, CommandItem, CommandList } from '../shadcn/command'

// Source reference: adapted from ShadcnBlocks command-command-standard-5 and command-command-popover-5.
interface DirectoryCommandItem {
  id: string
  title: ReactNode
  description?: ReactNode
  meta?: ReactNode
  icon?: ReactNode
  trailing?: ReactNode
  value?: string
}

interface DirectoryCommandProps {
  items: DirectoryCommandItem[]
  selectedIndex?: number
  emptyLabel?: ReactNode
  heading?: ReactNode
  footer?: ReactNode
  loading?: boolean
  loadingLabel?: ReactNode
  className?: string
  listClassName?: string
  onSelectItem?: (item: DirectoryCommandItem, index: number) => void
  onHoverItem?: (index: number) => void
}

function DirectoryCommand({
  items,
  selectedIndex = -1,
  emptyLabel = 'No results found.',
  heading,
  footer,
  loading = false,
  loadingLabel = 'Searching...',
  className,
  listClassName,
  onSelectItem,
  onHoverItem
}: DirectoryCommandProps) {
  const getItemValue = (item: DirectoryCommandItem) => item.value ?? item.id
  const selectedValue =
    selectedIndex >= 0 ? items[selectedIndex] && getItemValue(items[selectedIndex]) : undefined

  return (
    <Command
      shouldFilter={false}
      value={selectedValue}
      onValueChange={value => {
        const nextIndex = items.findIndex(item => getItemValue(item) === value)
        if (nextIndex >= 0) onHoverItem?.(nextIndex)
      }}
      className={cn(
        'h-auto w-full rounded-lg border bg-background shadow-lg [&_[cmdk-group-heading]]:sr-only',
        className
      )}
    >
      <CommandList className={cn('max-h-[400px]', listClassName)}>
        {loading ? (
          <div className="p-4 text-center text-muted-foreground">
            <div className="animate-pulse">{loadingLabel}</div>
          </div>
        ) : items.length === 0 ? (
          <CommandEmpty>{emptyLabel}</CommandEmpty>
        ) : (
          <CommandGroup heading={heading ?? 'Suggestions'} className="py-2">
            {items.map((item, index) => {
              const isSelected = index === selectedIndex

              return (
                <CommandItem
                  key={item.id}
                  value={getItemValue(item)}
                  onMouseEnter={() => onHoverItem?.(index)}
                  onSelect={() => onSelectItem?.(item, index)}
                  className={cn(
                    'group flex cursor-pointer items-start gap-3 px-4 py-3 text-left transition-colors',
                    'data-[selected=true]:bg-muted/50 hover:bg-muted/50',
                    isSelected && 'bg-muted/50'
                  )}
                >
                  {item.icon ? <div className="mt-0.5">{item.icon}</div> : null}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{item.title}</div>
                    {item.description ? (
                      <div className="mt-1 truncate text-xs text-muted-foreground">
                        {item.description}
                      </div>
                    ) : null}
                    {item.meta ? (
                      <div className="mt-1 text-xs text-muted-foreground">{item.meta}</div>
                    ) : null}
                  </div>
                  {item.trailing}
                </CommandItem>
              )
            })}
          </CommandGroup>
        )}
      </CommandList>
      {footer}
    </Command>
  )
}

export { DirectoryCommand }
export type { DirectoryCommandItem, DirectoryCommandProps }

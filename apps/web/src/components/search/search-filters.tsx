'use client'

import { Filter, X } from 'lucide-react'
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { categoryName, getCategoryIcon } from '../../lib/directory/categories'

interface SearchFiltersProps {
  selectedCategories: string[]
  onCategoryChange: (categories: string[]) => void
  availableCategories?: string[]
  /** D1's names by category slug (#416); a slug without one is named from itself. */
  categoryNames?: ReadonlyMap<string, string>
  resultCount?: number
}

export function SearchFilters({
  selectedCategories,
  onCategoryChange,
  availableCategories = [],
  categoryNames = new Map()
}: SearchFiltersProps) {
  const [isOpen, setIsOpen] = useState(false)

  const relevantCategories = [...new Set([...availableCategories, ...selectedCategories])]

  const handleCategoryToggle = (categorySlug: string, checked: boolean) => {
    if (checked) {
      onCategoryChange([...selectedCategories, categorySlug])
    } else {
      onCategoryChange(selectedCategories.filter(category => category !== categorySlug))
    }
  }

  const clearAllFilters = () => {
    onCategoryChange([])
  }

  const activeFiltersCount = selectedCategories.length

  if (relevantCategories.length === 0) return null

  return (
    <div className="flex items-center gap-2">
      <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
        <DropdownMenuTrigger
          render={<Button variant="outline" size="sm" className="gap-2 text-sm" />}
        >
          <Filter className="h-4 w-4 flex-shrink-0" />
          <span className="hidden sm:inline">Filter Results</span>
          <span className="sm:hidden">Filter</span>
          {activeFiltersCount > 0 && (
            <Badge className="ml-1 tabular-nums">{activeFiltersCount}</Badge>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64 sm:w-72 p-0">
          <div className="p-4">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold text-sm">Filter Results</h3>
              {activeFiltersCount > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={clearAllFilters}
                  className="text-xs h-auto px-2 py-1 hover:bg-muted transition-colors"
                >
                  Clear Filters
                </Button>
              )}
            </div>
            <div className="space-y-3 max-h-64 sm:max-h-80 overflow-y-auto">
              {relevantCategories.map(categorySlug => {
                const isSelected = selectedCategories.includes(categorySlug)
                const categoryCount = availableCategories.filter(
                  availableCategory => availableCategory === categorySlug
                ).length
                const Icon = getCategoryIcon(categorySlug)

                return (
                  <div key={categorySlug} className="flex items-center space-x-2">
                    <Checkbox
                      id={categorySlug}
                      checked={isSelected}
                      onCheckedChange={checked =>
                        handleCategoryToggle(categorySlug, checked as boolean)
                      }
                    />
                    <label
                      htmlFor={categorySlug}
                      className="flex items-center gap-2 text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer flex-1"
                    >
                      <Icon className="h-4 w-4 text-muted-foreground" />
                      <span className="flex-1">{categoryName(categorySlug, categoryNames)}</span>
                      {availableCategories.includes(categorySlug) && (
                        <span className="text-xs text-muted-foreground">({categoryCount})</span>
                      )}
                    </label>
                  </div>
                )
              })}
            </div>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>

      {activeFiltersCount > 0 && (
        <div className="flex items-center gap-1 flex-wrap">
          {selectedCategories.map(categorySlug => {
            const Icon = getCategoryIcon(categorySlug)
            const name = categoryName(categorySlug, categoryNames)

            return (
              <Badge key={categorySlug} variant="secondary" className="pr-0.5">
                <Icon />
                {name}
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => handleCategoryToggle(categorySlug, false)}
                  className="size-4"
                  aria-label={`Remove ${name} filter`}
                >
                  <X />
                </Button>
              </Badge>
            )
          })}
        </div>
      )}
    </div>
  )
}

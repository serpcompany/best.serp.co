'use client'

import { Heart } from 'lucide-react'
import { type MouseEvent, useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useFavorites } from '../layout/root-shell-client'

interface FavoriteButtonProps {
  slug: string
  className?: string
  size?: 'sm' | 'md' | 'lg'
  variant?: 'default' | 'ghost'
}

export function FavoriteButton({
  slug,
  className,
  size = 'md',
  variant = 'default'
}: FavoriteButtonProps) {
  const { isFavorite, toggleFavorite } = useFavorites()
  const [isAnimating, setIsAnimating] = useState(false)

  const favorited = isFavorite(slug)

  const handleClick = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()

    setIsAnimating(true)
    toggleFavorite(slug)
    setTimeout(() => setIsAnimating(false), 200)
  }

  const buttonSizes = { sm: 'icon-sm', md: 'icon', lg: 'icon-lg' } as const

  const iconSizeClasses = {
    sm: 'size-4',
    md: 'size-5',
    lg: 'size-6'
  }

  return (
    <Button
      variant={variant === 'default' ? 'outline' : 'ghost'}
      size={buttonSizes[size]}
      onClick={handleClick}
      className={cn('group/favorite relative z-20 rounded-full', className)}
      aria-label={favorited ? 'Remove from favorites' : 'Add to favorites'}
      title={favorited ? 'Remove from favorites' : 'Add to favorites'}
    >
      <Heart
        className={cn(
          'transition-all duration-200 antialiased',
          iconSizeClasses[size],
          favorited
            ? 'fill-destructive text-destructive'
            : 'text-muted-foreground group-hover/favorite:text-destructive/80',
          isAnimating && 'scale-125'
        )}
        style={{
          shapeRendering: 'auto',
          vectorEffect: 'non-scaling-stroke'
        }}
      />
    </Button>
  )
}

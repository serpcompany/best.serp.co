'use client'

import { Globe } from 'lucide-react'
import { useState } from 'react'
import { getListingLogoFallbackPath } from '../listing-logo-presentation'

interface FaviconProps {
  website: string
  fallbackIcon?: React.ComponentType<{ className?: string }>
  className?: string
  title?: string
}

/**
 * Displays a favicon with loading state and error handling
 * @param props - The component props
 * @returns React component that displays favicon or fallback icon
 */
export function Favicon({
  website,
  fallbackIcon: FallbackIcon = Globe,
  className = 'h-4 w-4',
  title
}: FaviconProps) {
  const [imageError, setImageError] = useState(false)
  const [imageLoading, setImageLoading] = useState(true)

  /**
   * Handles image load success
   */
  const handleImageLoad = () => {
    setImageLoading(false)
  }

  /**
   * Handles image load error
   */
  const handleImageError = () => {
    setImageError(true)
    setImageLoading(false)
  }

  // Extract size from className or use default
  const sizeMatch = className.match(/[hw]-(\d+)/)
  const size = sizeMatch ? Number.parseInt(sizeMatch[1], 10) * 4 : 16 // Convert Tailwind units to pixels

  if (imageError) {
    return (
      <div
        title={title}
        className={className}
        style={{ width: size, height: 'auto', aspectRatio: '1/1' }}
      >
        <FallbackIcon className="w-full h-full" />
      </div>
    )
  }

  const faviconUrl = getListingLogoFallbackPath()

  return (
    <div
      className={`relative ${className}`}
      style={{ width: size, height: 'auto', aspectRatio: '1/1' }}
    >
      {imageLoading && !imageError && (
        <div className="w-full h-full animate-pulse bg-muted rounded-sm" />
      )}
      {!imageError ? (
        <img
          src={faviconUrl}
          alt={`${title || website} logo`}
          width={size}
          height={size}
          className={`w-full h-full rounded-sm object-contain ${imageLoading ? 'invisible' : 'visible'}`}
          onLoad={handleImageLoad}
          onError={handleImageError}
          title={title}
        />
      ) : (
        <FallbackIcon className="w-full h-full" />
      )}
    </div>
  )
}

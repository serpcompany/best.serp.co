'use client'

import { Globe } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import {
  getListingLogoFallbackPath,
  shouldUseProvidedListingLogo
} from '../listing-logo-presentation'

interface FaviconWithFallbackProps {
  website: string
  name: string
  logoUrl?: string
  size?: number
  className?: string
}

/**
 * Displays a listing logo with a checked-in SERP fallback for missing or weak assets.
 * @param props - The component props
 * @returns React component that handles favicon loading and errors
 */
export function FaviconWithFallback({
  name,
  logoUrl,
  size = 32,
  className = 'rounded-lg'
}: FaviconWithFallbackProps) {
  const [candidateIndex, setCandidateIndex] = useState(0)
  const fallbackPath = getListingLogoFallbackPath()
  const shouldUseProvidedLogo = shouldUseProvidedListingLogo(logoUrl)
  const imageCandidates = useMemo(() => {
    const candidates: Array<{
      alt: string
      src: string
    }> = []

    if (shouldUseProvidedLogo && logoUrl) {
      candidates.push({
        alt: `${name} logo`,
        src: logoUrl
      })
    }

    candidates.push({
      alt: `${name} fallback logo`,
      src: fallbackPath
    })

    return candidates
  }, [fallbackPath, logoUrl, name, shouldUseProvidedLogo])

  useEffect(() => {
    setCandidateIndex(0)
  }, [imageCandidates])

  const currentImage = imageCandidates[candidateIndex]

  if (!currentImage) {
    return (
      <div
        className={`${className} flex-shrink-0 flex items-center justify-center bg-muted`}
        style={{ width: `${size}px`, height: `${size}px` }}
      >
        <Globe className="w-4 h-4 text-muted-foreground" />
      </div>
    )
  }

  return (
    <img
      src={currentImage.src}
      alt={currentImage.alt}
      width={size}
      height={size}
      className={`${className} flex-shrink-0 object-contain`}
      style={{ width: `${size}px`, height: 'auto', aspectRatio: '1/1' }}
      onError={() => {
        setCandidateIndex(currentIndex => currentIndex + 1)
      }}
    />
  )
}

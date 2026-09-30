import {
  getFeaturedOnBadgePreviewPath,
  getFeaturedOnBadgePreviewPathFromKey
} from '../website/featured-on-badge-url'

interface BadgePreviewProps {
  badgeKey?: string
  siteId: string
  theme: 'light' | 'dark'
}

export function BadgePreview({ badgeKey, siteId, theme }: BadgePreviewProps) {
  return (
    <img
      src={
        badgeKey
          ? getFeaturedOnBadgePreviewPathFromKey(badgeKey)
          : getFeaturedOnBadgePreviewPath(siteId, theme)
      }
      alt={`Featured on ${siteId}`}
      width={200}
      height={50}
      className="h-auto max-w-full"
    />
  )
}

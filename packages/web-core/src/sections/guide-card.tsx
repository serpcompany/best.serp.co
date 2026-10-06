import { Book, GraduationCap } from 'lucide-react'
import Image from 'next/image'
import Link from 'next/link'
import type { ComponentType, CSSProperties, ReactNode } from 'react'
import type { GuideMetadata } from '../content-query'
import { getRoute } from '../routes'

type BadgeProps = {
  children: ReactNode
  className?: string
  variant?: 'secondary'
}

type CardProps = {
  children: ReactNode
  className?: string
  style?: CSSProperties
}

type CardContentProps = {
  children: ReactNode
  className?: string
}

export interface GuideCardProps {
  guide: GuideMetadata
  index?: number
  slots: {
    Badge: ComponentType<BadgeProps>
    Card: ComponentType<CardProps>
    CardContent: ComponentType<CardContentProps>
  }
}

function getDifficultyColor(difficulty: GuideMetadata['difficulty']) {
  switch (difficulty) {
    case 'beginner':
      return 'bg-green-500/10 text-green-500 dark:bg-green-500/20'
    case 'intermediate':
      return 'bg-blue-500/10 text-blue-500 dark:bg-blue-500/20'
    case 'advanced':
      return 'bg-purple-500/10 text-purple-500 dark:bg-purple-500/20'
    default:
      return 'bg-gray-500/10 text-gray-500 dark:bg-gray-500/20'
  }
}

export function GuideCard({
  guide,
  index = 0,
  slots: { Badge, Card, CardContent },
}: GuideCardProps) {
  return (
    <Card
      className="p-0 gap-0 transition-all hover:border-primary hover:bg-muted/50 relative overflow-hidden animate-fade-in-up group"
      style={{ animationDelay: `${(index + 1) * 50}ms` }}
    >
      {guide.image ? (
        <div className="relative aspect-video w-full overflow-hidden">
          <Image
            src={guide.image}
            alt={guide.title}
            fill
            sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
            className="object-cover transition-transform duration-300 group-hover:scale-105"
          />
        </div>
      ) : null}
      <CardContent className="p-4 space-y-2">
        <div className="flex items-center gap-1.5">
          <Badge variant="secondary" className={getDifficultyColor(guide.difficulty)}>
            {guide.difficulty}
          </Badge>
        </div>
        <div className="space-y-1">
          <h3 className="font-semibold text-sm sm:text-base line-clamp-2">
            <Link
              href={getRoute('guides.guide', { slug: guide.slug })}
              className="block after:absolute after:inset-0 after:content-[''] z-10 hover:text-primary transition-colors"
            >
              {guide.title}
            </Link>
          </h3>
          <p className="text-xs sm:text-sm text-muted-foreground line-clamp-2">
            {guide.description}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          {guide.category === 'getting-started' ? (
            <Book className="size-4 text-muted-foreground" />
          ) : null}
          {guide.category === 'implementation' ? (
            <GraduationCap className="size-4 text-muted-foreground" />
          ) : null}
          <span className="text-xs text-muted-foreground capitalize">
            {guide.category.replace('-', ' ')}
          </span>
        </div>
      </CardContent>
    </Card>
  )
}

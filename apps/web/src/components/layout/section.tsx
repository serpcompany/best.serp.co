import { Button } from '@serpdirectory/design-system/button'
import {
  DirectoryPageSection,
  DirectorySectionAction,
  DirectorySectionDescription,
  DirectorySectionHeader,
  DirectorySectionTitle
} from '@serpdirectory/design-system/shadcnblocks/directory-home-section'
import { ArrowRight } from 'lucide-react'
import Link from 'next/link'
import type { ReactNode } from 'react'

export type SectionProps = {
  title: string
  description?: string
  children: ReactNode
  viewAllHref?: string
  viewAllText?: string
  titleId?: string
}

export function Section({
  children,
  title,
  description,
  viewAllHref,
  viewAllText = 'View all',
  titleId
}: SectionProps) {
  return (
    <DirectoryPageSection labelledBy={titleId ?? undefined}>
      <DirectorySectionHeader>
        <div className="space-y-0.5 sm:space-y-1 flex-1">
          <DirectorySectionTitle id={titleId}>
            <span
              className="inline-block w-1.5 h-1.5 rounded-full bg-foreground"
              aria-hidden="true"
            />
            {title}
          </DirectorySectionTitle>
          {description && <DirectorySectionDescription>{description}</DirectorySectionDescription>}
        </div>
        {viewAllHref && (
          <DirectorySectionAction>
            <Button
              asChild
              variant="ghost"
              className="group h-auto gap-0 rounded px-0 py-0 text-sm font-medium text-muted-foreground shadow-none transition-colors hover:bg-transparent hover:text-foreground active:scale-100 has-[>svg]:px-0 sm:text-base"
            >
              <Link href={viewAllHref} aria-label={viewAllText}>
                <span className="hidden sm:inline">{viewAllText}</span>
                <ArrowRight className="size-5 transition-transform group-hover:translate-x-0.5 sm:ml-2 sm:size-4" />
              </Link>
            </Button>
          </DirectorySectionAction>
        )}
      </DirectorySectionHeader>
      {children}
    </DirectoryPageSection>
  )
}

import { Button } from '@serpdirectory/design-system/button'
import {
  DirectoryHero,
  DirectoryHeroContainer
} from '@serpdirectory/design-system/shadcnblocks/directory-home-section'
import { ArrowRight } from 'lucide-react'
import Link from 'next/link'
import { getRoute } from '../routes'
import { siteConfig } from '../site-config'
import { siteCopy } from '../site-copy'
import { AnimatedBackground } from '../ui/animated-background'

interface HeroSectionProps {
  websiteCount: number
}

export function HeroSection({ websiteCount }: HeroSectionProps) {
  return (
    <DirectoryHero>
      <AnimatedBackground />
      <DirectoryHeroContainer>
        <div className="animate-fade-in-up opacity-0 stagger-1">
          <Link
            className="mx-auto inline-flex items-center gap-2 rounded-full border border-foreground/10 bg-background/50 px-3 py-1.5 text-xs font-medium backdrop-blur-sm transition-all hover:border-foreground/20 hover:bg-background/80 md:gap-3 md:text-sm"
            href={getRoute('home')}
          >
            <span className="inline-flex items-center rounded-full bg-foreground px-2.5 py-0.5 text-xs font-bold tabular-nums text-background">
              {websiteCount}
            </span>
            <span className="text-muted-foreground">{siteCopy.listingCountLabel}</span>
          </Link>
        </div>

        <h1 className="animate-fade-in-up opacity-0 stagger-2 text-4xl font-bold leading-[1.1] tracking-tight md:text-5xl lg:text-6xl xl:text-7xl">
          <span className="relative md:whitespace-nowrap">
            <span className="bg-gradient-to-r from-foreground via-foreground/80 to-foreground bg-clip-text text-transparent">
              {siteConfig.name}
            </span>
          </span>
        </h1>

        <p className="animate-fade-in-up opacity-0 stagger-3 mx-auto max-w-2xl text-base leading-relaxed text-muted-foreground md:text-lg lg:text-xl">
          <span className="font-medium text-foreground">{siteConfig.tagline}</span> and browse
          curated {siteCopy.listingName.plural}, resources, and documentation links in one
          searchable directory
        </p>

        <div className="animate-fade-in-up opacity-0 stagger-4 flex flex-col justify-center gap-3 pt-2 sm:flex-row md:gap-4">
          <Button
            asChild
            className="group h-auto rounded-none bg-foreground px-6 py-3 text-sm font-bold text-background shadow-none transition-all duration-300 hover:gap-3 hover:bg-foreground/90 active:scale-100 press-effect has-[>svg]:px-6 md:px-8 md:py-4 md:text-base md:has-[>svg]:px-8"
          >
            <Link href={getRoute('submit')}>
              {siteCopy.submitLabel}
              <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
            </Link>
          </Button>
        </div>
      </DirectoryHeroContainer>
    </DirectoryHero>
  )
}

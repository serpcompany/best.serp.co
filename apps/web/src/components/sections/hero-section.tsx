import { ArrowRight } from 'lucide-react'
import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { getRoute } from '../../lib/routing/routes'
import { siteConfig } from '../../lib/site/site-config'
import { siteCopy } from '../../lib/site/site-copy'
import { AnimatedBackground } from './animated-background'
import { DirectoryHero, DirectoryHeroContainer } from './directory-home-section'

interface HeroSectionProps {
  websiteCount: number
}

export function HeroSection({ websiteCount }: HeroSectionProps) {
  return (
    <DirectoryHero>
      <AnimatedBackground />
      <DirectoryHeroContainer>
        <div className="animate-fade-in-up opacity-0 stagger-1">
          <Badge
            variant="outline"
            className="mx-auto h-auto py-1 pl-1"
            render={<Link href={getRoute('home')} />}
          >
            <Badge className="tabular-nums">{websiteCount}</Badge>
            <span className="text-muted-foreground">{siteCopy.listingCountLabel}</span>
          </Badge>
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
          <Link href={getRoute('submit')} className={buttonVariants({ size: 'lg' })}>
            {siteCopy.submitLabel}
            <ArrowRight data-icon="inline-end" />
          </Link>
        </div>
      </DirectoryHeroContainer>
    </DirectoryHero>
  )
}

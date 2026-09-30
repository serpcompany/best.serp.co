import type { ComponentType, ReactNode } from 'react'
import { SITE_PUBLIC_URL } from '../seo-config'

type BreadcrumbItem = {
  href: string
  name: string
}

type WebsiteHeroWebsite = {
  description: string
  isUnofficial?: boolean
  media?: {
    logo?: string
  }
  name: string
  slug: string
  website: string
}

type FavoriteButtonProps = {
  className?: string
  slug: string
  size?: 'sm' | 'md' | 'lg'
  variant?: 'default' | 'ghost'
}

type FaviconWithFallbackProps = {
  className?: string
  logoUrl?: string
  name: string
  size?: number
  website: string
}

type BreadcrumbProps = {
  baseUrl?: string
  items: BreadcrumbItem[]
}

type BadgeProps = {
  children: ReactNode
  className?: string
  variant?: 'outline'
}

export type WebsiteHeroProps = {
  breadcrumbItems: BreadcrumbItem[]
  website: WebsiteHeroWebsite
  slots: {
    Badge: ComponentType<BadgeProps>
    Breadcrumb: ComponentType<BreadcrumbProps>
    FavoriteButton: ComponentType<FavoriteButtonProps>
    FaviconWithFallback: ComponentType<FaviconWithFallbackProps>
  }
}

export function WebsiteHero({
  breadcrumbItems,
  website,
  slots: { Badge, Breadcrumb, FavoriteButton, FaviconWithFallback }
}: WebsiteHeroProps) {
  return (
    <section className="relative overflow-hidden border-b border-border/50 bg-gradient-to-b from-muted/30 via-background to-background">
      <div className="absolute inset-0 -z-10">
        <div className="absolute inset-0 bg-[linear-gradient(to_right,#8080800a_1px,transparent_1px),linear-gradient(to_bottom,#8080800a_1px,transparent_1px)] bg-[size:32px_32px]" />
        <div className="absolute left-0 right-0 top-0 -z-10 m-auto h-[310px] w-full bg-gradient-to-br from-primary/5 via-transparent to-secondary/5 blur-[100px]" />
      </div>

      <div className="container mx-auto px-6 py-8 md:py-12">
        <div className="animate-fade-in-up opacity-0 stagger-1 mb-8 max-w-6xl mx-auto">
          <Breadcrumb items={breadcrumbItems} baseUrl={SITE_PUBLIC_URL} />
        </div>

        <div className="animate-fade-in-up opacity-0 stagger-2 max-w-6xl mx-auto">
          <div className="flex flex-col md:flex-row md:items-start gap-6 md:gap-8">
            <div className="flex-shrink-0">
              <div className="relative block rounded-2xl">
                <div className="relative overflow-hidden rounded-2xl border border-border/50 bg-card p-3 shadow-lg">
                  <FaviconWithFallback
                    website={website.website}
                    name={website.name}
                    logoUrl={website.media?.logo}
                    size={72}
                    className="rounded-xl"
                  />
                </div>
              </div>
            </div>

            <div className="flex-1 space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <h1 className="text-3xl md:text-4xl lg:text-5xl font-bold tracking-tight text-pretty">
                      {website.name}
                    </h1>
                    {website.isUnofficial && (
                      <Badge
                        variant="outline"
                        className="text-xs border-amber-500/30 bg-amber-500/10 text-amber-700 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-300"
                      >
                        Unofficial
                      </Badge>
                    )}
                  </div>
                </div>

                <FavoriteButton slug={website.slug} size="lg" variant="default" />
              </div>

              <p className="text-lg text-muted-foreground leading-relaxed max-w-2xl text-pretty">
                {website.description}
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

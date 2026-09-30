import { Badge } from '@serpdirectory/design-system/badge'
import { Breadcrumb } from '@serpdirectory/design-system/breadcrumb'
import { Button } from '@serpdirectory/design-system/button'
import { ArrowRight, ExternalLink, Plus } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { networkLinks } from './network-links'
import { getRoute } from './routes'
import { generateBaseMetadata, SITE_PUBLIC_URL } from './seo-config'
import { siteConfig } from './site-config'
import { siteCopy } from './site-copy'
import { Card, CardContent } from './ui/card'

export function generateProjectsPageMetadata(): Metadata {
  return generateBaseMetadata({
    title: siteConfig.copy.networkLabel,
    description: `Explore related brands, repositories, partners, and contribution links for ${siteConfig.name}.`,
    path: getRoute('projects'),
    keywords: ['network', 'resources', 'repositories', 'partners', siteConfig.name]
  })
}

export function ProjectsPageRoute() {
  return (
    <div className="container mx-auto py-8">
      <div className="space-y-12">
        <Breadcrumb
          items={[{ name: siteCopy.networkLabel, href: getRoute('projects') }]}
          baseUrl={SITE_PUBLIC_URL}
        />

        <div className="space-y-2">
          <h1 className="text-4xl font-bold tracking-tight flex items-center gap-3">
            <span className="size-2 bg-primary rounded-full" />
            {siteCopy.networkLabel}
          </h1>
          <p className="text-lg text-muted-foreground max-w-3xl">
            Browse linked brands, repositories, partner sites, and related resources.
          </p>
        </div>

        <Card className="transition-all hover:border-primary hover:bg-muted/50 relative overflow-hidden animate-fade-in-up">
          <CardContent className="p-6 sm:p-8">
            <div className="flex flex-col gap-4">
              <div className="flex items-center justify-between">
                <Badge variant="secondary" className="bg-primary/10 text-primary">
                  Static-Friendly
                </Badge>
                <ExternalLink className="size-5 text-muted-foreground" />
              </div>

              <div className="space-y-3">
                <h2 className="text-xl sm:text-2xl font-bold tracking-tight">
                  Browse linked brands and related resources
                </h2>
                <p className="text-muted-foreground">
                  Use the links below to surface partner destinations, repositories, issue flows,
                  and other related pages connected to this directory.
                </p>
              </div>

              <div className="flex items-center gap-3 pt-2">
                <span className="text-sm font-medium text-primary flex items-center gap-1">
                  Explore resources
                  <ArrowRight className="size-4" />
                </span>
              </div>
            </div>
          </CardContent>
        </Card>

        <section className="space-y-6">
          <h2 className="text-sm font-bold uppercase tracking-wider text-muted-foreground">
            {siteCopy.networkLabel} Resources ({networkLinks.length})
          </h2>
          <div className="grid gap-4 sm:gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {networkLinks.map(resource => (
              <Card
                key={resource.href}
                className="transition-all hover:border-primary hover:bg-muted/50"
              >
                <CardContent className="p-6 space-y-4">
                  <div className="flex items-center justify-between">
                    <Badge variant="outline">{resource.label}</Badge>
                    <ExternalLink className="size-5 text-muted-foreground" />
                  </div>
                  <div className="space-y-2">
                    <h3 className="text-lg font-semibold tracking-tight">{resource.title}</h3>
                    <p className="text-sm text-muted-foreground">{resource.description}</p>
                  </div>
                  <Button variant="outline" asChild className="rounded-none h-9 font-bold w-full">
                    <Link href={resource.href} target="_blank" rel="noopener noreferrer">
                      Open link
                      <ExternalLink className="ml-2 size-4" />
                    </Link>
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        <Card className="border-dashed">
          <CardContent className="p-8 text-center">
            <div className="mx-auto max-w-2xl space-y-4">
              <div className="size-12 rounded-full bg-muted flex items-center justify-center mx-auto">
                <Plus className="size-6 text-muted-foreground" />
              </div>
              <h2 className="text-2xl font-bold tracking-tight">Have a listing to submit?</h2>
              <p className="text-muted-foreground">
                Submit through GitHub issues and keep the directory transparent, reviewable, and
                easy to host anywhere.
              </p>
              <div className="flex justify-center gap-3 pt-2">
                <Button asChild className="rounded-none h-9 font-bold">
                  <Link href={getRoute('submit')}>{siteCopy.submitLabel}</Link>
                </Button>
                <Button variant="outline" asChild className="rounded-none h-9 font-bold">
                  <Link href={siteConfig.githubRepoUrl} target="_blank" rel="noopener noreferrer">
                    View Repository
                    <ExternalLink className="ml-2 size-4" />
                  </Link>
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

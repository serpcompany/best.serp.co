import { Code, FileText, Zap } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'
import type { ComponentType, ReactNode } from 'react'
import type { AboutPageMetadata } from '../content-query'
import { getRoute } from '../routes'
import { generateBaseMetadata } from '../seo-config'
import { siteConfig } from '../site-config'

const ABOUT_STEP_ICONS = {
  code: Code,
  'file-text': FileText,
  zap: Zap
} as const

interface AboutCardSlots {
  Button: ComponentType<{
    asChild?: boolean
    children: ReactNode
    variant?: 'default' | 'outline'
  }>
  Card: ComponentType<{ children: ReactNode }>
  CardContent: ComponentType<{ children: ReactNode }>
  CardHeader: ComponentType<{ children: ReactNode }>
  CardTitle: ComponentType<{ children: ReactNode; className?: string }>
}

interface AboutStaticPageProps {
  aboutPage: AboutPageMetadata
  slots: AboutCardSlots
}

export function generateAboutPageMetadata(aboutPage: AboutPageMetadata | null): Metadata {
  if (!aboutPage) {
    return generateBaseMetadata({
      title: 'About',
      description: '',
      path: '/about'
    })
  }

  return generateBaseMetadata({
    title: aboutPage.metaTitle,
    description: aboutPage.metaDescription,
    path: '/about',
    keywords: aboutPage.keywords
  })
}

export function AboutStaticPage({ aboutPage, slots }: AboutStaticPageProps) {
  const { Button, Card, CardContent, CardHeader, CardTitle } = slots
  const hasContactSection = Boolean(
    aboutPage.contactTitle && aboutPage.contactBody && aboutPage.contactEmail
  )
  const hasStepsSection = Boolean(aboutPage.stepsTitle && aboutPage.steps?.length)
  const hasCommunitySection = Boolean(aboutPage.communityTitle && aboutPage.communityBody)

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="max-w-3xl mx-auto space-y-8">
        <section className="space-y-4">
          <h1 className="text-4xl font-bold">{aboutPage.introTitle}</h1>
          <p className="text-xl text-muted-foreground">{aboutPage.introBody}</p>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-semibold">{aboutPage.whatIsTitle}</h2>
          <p>{aboutPage.whatIsBody}</p>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-semibold">{aboutPage.missionTitle}</h2>
          <p>{aboutPage.missionIntro}</p>
          <ul className="list-disc list-inside space-y-2">
            {aboutPage.missionItems.map(item => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>

        {hasStepsSection && (
          <section className="space-y-4">
            <h2 className="text-2xl font-semibold">{aboutPage.stepsTitle}</h2>
            <div className="grid md:grid-cols-3 gap-6">
              {aboutPage.steps?.map(step => {
                const StepIcon = ABOUT_STEP_ICONS[step.icon]

                return (
                  <Card key={step.title}>
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2">
                        <StepIcon className="h-5 w-5" />
                        {step.title}
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p>{step.body}</p>
                    </CardContent>
                  </Card>
                )
              })}
            </div>
          </section>
        )}

        <section className="space-y-4">
          {hasCommunitySection && (
            <>
              <h2 className="text-2xl font-semibold">{aboutPage.communityTitle}</h2>
              <p>{aboutPage.communityBody}</p>
            </>
          )}
          <div className="flex flex-col sm:flex-row gap-4">
            <Button asChild>
              <Link href={getRoute('submit')}>{aboutPage.primaryCtaLabel}</Link>
            </Button>
            {siteConfig.features.showProjects && (
              <Button asChild variant="outline">
                <Link href={getRoute('projects')}>{aboutPage.secondaryCtaLabel}</Link>
              </Button>
            )}
          </div>
        </section>

        {hasContactSection && (
          <section className="space-y-4">
            <h2 className="text-2xl font-semibold">{aboutPage.contactTitle}</h2>
            <p>
              {aboutPage.contactBody}{' '}
              <a href={`mailto:${aboutPage.contactEmail}`} className="text-primary hover:underline">
                {aboutPage.contactEmail}
              </a>
            </p>
          </section>
        )}
      </div>
    </div>
  )
}

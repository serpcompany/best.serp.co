import { Check, Code, FileText, Mail, Zap } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { CardGrid } from '@/components/layout/card-grid'
import { ListCard } from '@/components/layout/list-card'
import { PageHero } from '@/components/layout/page-hero'
import { PageSection } from '@/components/layout/page-shell'
import { SectionHeader } from '@/components/layout/section-header'
import { buttonVariants } from '@/components/ui/button'
import type { AboutPageMetadata } from '../../lib/directory/content-query'
import { getRoute } from '../../lib/routing/routes'
import { generateBaseMetadata } from '../../lib/seo/seo-config'
import { siteConfig } from '../../lib/site/site-config'

const ABOUT_STEP_ICONS = {
  code: Code,
  'file-text': FileText,
  zap: Zap
} as const

interface AboutStaticPageProps {
  aboutPage: AboutPageMetadata
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

export function AboutStaticPage({ aboutPage }: AboutStaticPageProps) {
  const hasContactSection = Boolean(
    aboutPage.contactTitle && aboutPage.contactBody && aboutPage.contactEmail
  )
  const hasStepsSection = Boolean(aboutPage.stepsTitle && aboutPage.steps?.length)
  const hasCommunitySection = Boolean(aboutPage.communityTitle && aboutPage.communityBody)

  return (
    <>
      <PageSection spacing="hero">
        <PageHero
          align="center"
          title={aboutPage.introTitle}
          description={aboutPage.introBody}
          actions={
            <>
              <Link href={getRoute('submit')} className={buttonVariants()}>
                {aboutPage.primaryCtaLabel}
              </Link>
              {siteConfig.features.showProjects && (
                <Link
                  href={getRoute('projects')}
                  className={buttonVariants({ variant: 'outline' })}
                >
                  {aboutPage.secondaryCtaLabel}
                </Link>
              )}
            </>
          }
        />
      </PageSection>

      <PageSection className="pt-0" spacing="spacious" width="narrow">
        <div className="flex flex-col gap-12">
          <section aria-labelledby="about-what-is">
            <SectionHeader id="about-what-is" title={aboutPage.whatIsTitle} />
            <p className="text-muted-foreground">{aboutPage.whatIsBody}</p>
          </section>

          <section aria-labelledby="about-mission">
            <SectionHeader id="about-mission" title={aboutPage.missionTitle} />
            <p className="mb-6 text-muted-foreground">{aboutPage.missionIntro}</p>
            {/* serplists' checked list (its feature page's panel). */}
            <ul className="flex flex-col gap-4 text-sm">
              {aboutPage.missionItems.map(item => (
                <li key={item} className="flex items-start gap-3">
                  <Check
                    aria-hidden="true"
                    className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                  />
                  {item}
                </li>
              ))}
            </ul>
          </section>

          {hasStepsSection && (
            <section aria-labelledby="about-steps">
              <SectionHeader id="about-steps" title={aboutPage.stepsTitle} />
              <CardGrid as="ul">
                {aboutPage.steps?.map(step => {
                  const StepIcon = ABOUT_STEP_ICONS[step.icon]
                  return (
                    <li key={step.title} className="min-w-0">
                      <ListCard
                        className="h-full"
                        description={step.body}
                        icon={<StepIcon />}
                        title={step.title}
                        titleAs="h3"
                      />
                    </li>
                  )
                })}
              </CardGrid>
            </section>
          )}

          {hasCommunitySection && (
            <section aria-labelledby="about-community">
              <SectionHeader id="about-community" title={aboutPage.communityTitle} />
              <p className="text-muted-foreground">{aboutPage.communityBody}</p>
            </section>
          )}

          {hasContactSection && (
            <section aria-labelledby="about-contact">
              <SectionHeader
                id="about-contact"
                title={aboutPage.contactTitle}
                description={aboutPage.contactBody}
              />
              <ListCard
                href={`mailto:${aboutPage.contactEmail}`}
                icon={<Mail />}
                title={aboutPage.contactEmail}
              />
            </section>
          )}
        </div>
      </PageSection>
    </>
  )
}

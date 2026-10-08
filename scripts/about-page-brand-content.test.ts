import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { site } from '../apps/web/src/lib/site'

const aboutPath = resolve(process.cwd(), 'apps/web/content/about/about.mdx')

const bannedDomainPhrases = [
  'directory starter',
  'This starter',
  'Each site built from this starter',
  'contact@example.com',
  'marketing@serp.co',
  'About this directory',
  'great products',
  'Contact Us',
  'mailto:'
]

const removedCommunitySections = [
  'Adult-Only Scope',
  'Porn Video Downloaders is useful because its boundary is clear',
  'The Standard',
  'SERP AI should be honest about its live pages',
  'What Makes SERP Useful',
  'SERP should stay broad without becoming vague',
  'What Makes a Good Listing',
  'SERP Software is strongest when each listing is plain about what the tool does',
  'A SERP Downloaders listing should help someone identify the downloader'
]

const removedStepsSections = [
  'Using BrowserExtensions.io',
  'Using the Catalog',
  'Using SERP AI',
  'Using SERP',
  'Using SERP Software',
  'Using SERP Downloaders',
  'Browse by task',
  'Start with adult platforms',
  'Explore the live catalog',
  'Start with a category',
  'Browse downloader software',
  'Search by product or platform'
]

function readAbout(): string {
  return readFileSync(aboutPath, 'utf8')
}

describe('best.serp.co About page brand content', () => {
  it('keeps one site-owned About MDX file in the site config package', () => {
    expect(aboutPath, 'best.serp.co must own About content').toSatisfy(existsSync)
  })

  it('removes starter and placeholder copy from the About MDX', () => {
    const aboutMdx = readAbout()
    const lowerAboutMdx = aboutMdx.toLowerCase()

    expect(aboutMdx, 'About copy should name the domain').toContain(site.site.domain)
    expect(aboutMdx, 'About copy should name the site').toContain(site.site.name)

    for (const phrase of bannedDomainPhrases) {
      expect(lowerAboutMdx, `About copy should not contain "${phrase}"`).not.toContain(
        phrase.toLowerCase()
      )
    }

    expect(aboutMdx).not.toContain('contactTitle:')
    expect(aboutMdx).not.toContain('contactBody:')
    expect(aboutMdx).not.toContain('contactEmail:')
    expect(aboutMdx).not.toContain('stepsTitle:')
    expect(aboutMdx).not.toContain('steps:')

    for (const phrase of [...removedCommunitySections, ...removedStepsSections]) {
      expect(aboutMdx, `About copy should not restore "${phrase}"`).not.toContain(phrase)
    }
  })

  it('renders optional shared About sections only when frontmatter exists', () => {
    const aboutRenderer = readFileSync(
      resolve(process.cwd(), 'apps/web/src/components/static-pages/about-page.tsx'),
      'utf8'
    )

    expect(aboutRenderer).toContain('hasContactSection')
    expect(aboutRenderer).toContain('{hasContactSection && (')
    expect(aboutRenderer).toContain('hasStepsSection')
    expect(aboutRenderer).toContain('{hasStepsSection && (')
    expect(aboutRenderer).toContain('hasCommunitySection')
    expect(aboutRenderer).toContain('{hasCommunitySection && (')
  })

  it('points the web app at the site-owned About collection', () => {
    const source = readFileSync(resolve(process.cwd(), 'apps/web/content-collections.ts'), 'utf8')

    expect(source).toContain("const aboutPath = './content/about'")
  })

  it('renders About with the shared content loader', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'apps/web/src/app/(site)/about/page.tsx'),
      'utf8'
    )

    expect(source).toContain("import { getAboutPage } from '@/lib/content-loader'")
    expect(source).toContain('AboutStaticPage')
    expect(source).toContain('generateAboutPageMetadata')
    expect(source).not.toContain('great products')
    expect(source).not.toContain('export const metadata')
  })
})

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { activeCheckedInSiteIds } from '@serpdirectory/site-contract/active-site-ids'
import { describe, expect, it } from 'vitest'

const activeSiteIds = [...activeCheckedInSiteIds]
const bannedActiveDomainPhrases = [
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

const expectedSiteNames: Record<string, string> = {
  'pornvideodownloaders.com': 'Porn Video Downloaders',
  'serp.software': 'SERP Software'
}

function siteAboutPath(siteId: string): string {
  return resolve(process.cwd(), 'sites', siteId, 'content/about/about.mdx')
}

function readSiteAbout(siteId: string): string {
  return readFileSync(siteAboutPath(siteId), 'utf8')
}

function aboutArtifactPath(siteId: string): string {
  return resolve(process.cwd(), 'dist', 'sites', siteId, 'about/index.html')
}

describe('active site About page brand content', () => {
  it('keeps one site-owned About MDX file for every active checked-in site', () => {
    expect(activeSiteIds).toEqual(['pornvideodownloaders.com', 'serp.software'])

    for (const siteId of activeSiteIds) {
      expect(siteAboutPath(siteId), `${siteId} must own About content`).toSatisfy(existsSync)
    }
  })

  it('removes starter and placeholder copy from active-domain About MDX', () => {
    for (const siteId of activeSiteIds) {
      const aboutMdx = readSiteAbout(siteId)
      const lowerAboutMdx = aboutMdx.toLowerCase()

      expect(aboutMdx, `${siteId} About copy should name the domain`).toContain(siteId)
      expect(aboutMdx, `${siteId} About copy should name the site`).toContain(
        expectedSiteNames[siteId]
      )

      for (const phrase of bannedActiveDomainPhrases) {
        expect(lowerAboutMdx, `${siteId} About copy should not contain "${phrase}"`).not.toContain(
          phrase.toLowerCase()
        )
      }

      expect(aboutMdx).not.toContain('contactTitle:')
      expect(aboutMdx).not.toContain('contactBody:')
      expect(aboutMdx).not.toContain('contactEmail:')
      expect(aboutMdx).not.toContain('stepsTitle:')
      expect(aboutMdx).not.toContain('steps:')

      for (const phrase of removedCommunitySections) {
        expect(aboutMdx, `${siteId} About copy should not restore "${phrase}"`).not.toContain(
          phrase
        )
      }

      for (const phrase of removedStepsSections) {
        expect(aboutMdx, `${siteId} About copy should not restore "${phrase}"`).not.toContain(
          phrase
        )
      }
    }
  })

  it('renders optional shared About sections only when frontmatter exists', () => {
    const aboutRenderer = readFileSync(
      resolve(process.cwd(), 'packages/web-core/src/static-pages/about-page.tsx'),
      'utf8'
    )

    expect(aboutRenderer).toContain('hasContactSection')
    expect(aboutRenderer).toContain('{hasContactSection && (')
    expect(aboutRenderer).toContain('hasStepsSection')
    expect(aboutRenderer).toContain('{hasStepsSection && (')
    expect(aboutRenderer).toContain('hasCommunitySection')
    expect(aboutRenderer).toContain('{hasCommunitySection && (')
  })

  it('points each active wrapper at its site-owned About collection', () => {
    for (const siteId of activeSiteIds) {
      const contentCollectionsPath = resolve(
        process.cwd(),
        'apps',
        siteId,
        'content-collections.ts'
      )
      const source = readFileSync(contentCollectionsPath, 'utf8')

      expect(source).toContain(`const aboutPath = '../../sites/${siteId}/content/about'`)
      expect(source).not.toContain("const aboutPath = '../../packages/content/data/about'")
    }
  })

  it('renders SERP Software About with the shared content loader', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'apps/serp.software/app/about/page.tsx'),
      'utf8'
    )

    expect(source).toContain("import { getAboutPage } from '@/lib/content-loader'")
    expect(source).toContain('AboutStaticPage')
    expect(source).toContain('generateAboutPageMetadata')
    expect(source).not.toContain('SERP Software is a curated directory')
    expect(source).not.toContain('great products')
    expect(source).not.toContain('export const metadata')
  })

  it.runIf(activeSiteIds.every(siteId => existsSync(aboutArtifactPath(siteId))))(
    'renders active About artifacts without starter or contact copy',
    () => {
      for (const siteId of activeSiteIds) {
        const html = readFileSync(aboutArtifactPath(siteId), 'utf8')

        expect(html, `${siteId} About artifact should name the domain`).toContain(siteId)
        expect(html, `${siteId} About artifact should name the site`).toContain(
          expectedSiteNames[siteId]
        )

        for (const phrase of bannedActiveDomainPhrases) {
          expect(
            html.toLowerCase(),
            `${siteId} About artifact should not contain "${phrase}"`
          ).not.toContain(phrase.toLowerCase())
        }

        for (const phrase of removedCommunitySections) {
          expect(html, `${siteId} About artifact should not restore "${phrase}"`).not.toContain(
            phrase
          )
        }

        for (const phrase of removedStepsSections) {
          expect(html, `${siteId} About artifact should not restore "${phrase}"`).not.toContain(
            phrase
          )
        }
      }
    }
  )
})

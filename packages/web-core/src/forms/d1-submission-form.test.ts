import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'

describe('buildBadgeSubmissionInstructions', () => {
  afterEach(() => {
    delete process.env.SITE_ID
    delete process.env.NEXT_PUBLIC_SITE_ID
    vi.resetModules()
  })

  it('builds serp.software badge snippets for a D1 submission capability', async () => {
    process.env.SITE_ID = 'serp.software'
    vi.resetModules()

    const {
      buildBadgeSubmissionInstructions,
      buildSubmissionResumeHash,
      parseSubmissionResumeHash
    } = await import('./d1-submission-form')
    const instructions = buildBadgeSubmissionInstructions({
      submissionId: 'submission-id',
      token: 'capability-token',
      name: 'SERP AI',
      website: 'https://www.serp.ai/'
    })

    expect(instructions.submissionId).toBe('submission-id')
    expect(instructions.token).toBe('capability-token')
    expect(instructions.website).toBe('https://www.serp.ai/')
    expect(instructions.listingUrl).toBe('https://serp.software/products/serp.ai/')
    expect(instructions.badgePreviewPaths.light).toBe('/badge/featured-on-serp.software-light.svg')
    expect(instructions.badgePreviewPaths.dark).toBe('/badge/featured-on-serp.software-dark.svg')
    expect(
      instructions.badgeEmbeds.light
    ).toBe(`<a href="https://serp.software/products/serp.ai/" target="_blank" rel="noopener noreferrer" title="Featured on SERP Software">
  <img src="https://serp.software/badge/featured-on-serp.software-light.svg" alt="Featured on SERP Software" width="200" height="50" />
</a>`)
    expect(instructions.badgeEmbeds.dark).toContain(
      'https://serp.software/badge/featured-on-serp.software-dark.svg'
    )

    const resumeCapability = {
      submissionId: '11111111-1111-4111-8111-111111111111',
      token: 'a'.repeat(43)
    }
    const resumeHash = buildSubmissionResumeHash(resumeCapability)
    expect(resumeHash).toMatch(/^#submission=/)
    expect(parseSubmissionResumeHash(resumeHash)).toEqual(resumeCapability)
    expect(parseSubmissionResumeHash('#submission=invalid&token=short')).toBeNull()
    expect(new URL(`https://serp.software/submit/${resumeHash}`).search).toBe('')
  })

  it('builds pornvideodownloaders.com badge snippets without selecting serp.software', async () => {
    process.env.SITE_ID = 'pornvideodownloaders.com'
    process.env.NEXT_PUBLIC_SITE_ID = 'pornvideodownloaders.com'
    vi.resetModules()

    const { buildBadgeSubmissionInstructions } = await import('./d1-submission-form')
    const instructions = buildBadgeSubmissionInstructions({
      submissionId: 'submission-id',
      token: 'capability-token',
      name: 'Example Downloader',
      website: 'https://example.com/'
    })

    expect(instructions.listingUrl).toBe('https://pornvideodownloaders.com/products/example.com/')
    expect(instructions.badgePreviewPaths.light).toBe(
      '/badge/featured-on-pornvideodownloaders.com-light.svg'
    )
    expect(instructions.badgeEmbeds.dark).toContain(
      'https://pornvideodownloaders.com/badge/featured-on-pornvideodownloaders.com-dark.svg'
    )
    expect(instructions.badgeEmbeds.light).toContain('Featured on PV Downloaders')
    expect(instructions.badgeEmbeds.light).not.toContain('serp.software')
  })

  it('makes the saved submission and resumable verification lifecycle explicit', () => {
    const source = readFileSync('packages/web-core/src/forms/d1-submission-form.tsx', 'utf8')
    expect(source).toContain('Submission saved')
    expect(source).toContain('Continue badge verification')
    expect(source).toContain('Copy private resume link')
    expect(source).toContain('this browser will remember your submission')
    expect(source).toContain('return later without losing your progress')
    expect(source).toContain('SUBMISSION_RESUME_STORAGE_KEY')
    expect(source).toContain('parseSubmissionResumeHash(window.location.hash)')
    expect(source).toContain('open={Boolean(badgeInstructions) && verificationDialogOpen}')
    expect(source).toContain('Badge verification is required')
    expect(source).toContain('Your submission enters admin review')
    expect(source).toContain('Badge verified — admin notified within a few minutes')
    expect(source).toContain('URL checked:')
    expect(source).toContain('A badge added')
    expect(source).toContain('only after JavaScript runs cannot be detected')
    expect(source).toContain('result.lastVerificationError || result.code')
    expect(source).not.toContain('Badge not verified (')
  })
})

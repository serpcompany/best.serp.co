import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { inspectLegacySite } from './migration/preflight.ts'

function sourceFixture(): { root: string; site: string } {
  const root = mkdtempSync(resolve(tmpdir(), 'directory-migration-'))
  const site = 'example.com'
  const siteDirectory = resolve(root, 'sites', site)
  mkdirSync(resolve(siteDirectory, 'assets'), { recursive: true })
  writeFileSync(resolve(siteDirectory, 'README.md'), '# Source\n')
  writeFileSync(resolve(siteDirectory, 'site-config.ts'), 'export const config = {}\n')
  writeFileSync(resolve(siteDirectory, 'site-content.ts'), 'export const content = {}\n')
  writeFileSync(
    resolve(siteDirectory, 'categories.json'),
    JSON.stringify([{ slug: 'video-tools', name: 'Video tools', description: 'Video products.' }])
  )
  writeFileSync(
    resolve(siteDirectory, 'products.json'),
    JSON.stringify({
      'example-tool': {
        product: {
          categories: ['video-tools'],
          productPage: 'https://example.com/tool',
          slug: 'example-tool',
          tagline: 'A complete product description.',
          title: 'Example Tool'
        },
        content: { body: '## Overview\n\nUseful product.' },
        media: { images: ['https://example.com/image.png'] },
        relatedLinks: [{ label: 'Docs', url: 'https://example.com/docs' }]
      }
    })
  )
  execFileSync('git', ['init', '--quiet'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 'migration-test@example.com'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'Migration Test'], { cwd: root })
  execFileSync('git', ['remote', 'add', 'origin', 'https://example.com/source.git'], { cwd: root })
  commitFixture(root)
  return { root, site }
}

function commitFixture(root: string): void {
  execFileSync('git', ['add', '.'], { cwd: root })
  execFileSync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: root })
}

function writeTrialAdapterConfig(root: string, site: string): void {
  writeFileSync(
    resolve(root, 'sites', site, 'site-config.ts'),
    `export const config = {
      content: {
        listingSource: {
          category: 'video-tools',
          featuredCount: 6,
          kind: 'trial-products-json',
          publishedAt: '2026-05-03'
        }
      }
    }\n`
  )
}

describe('legacy migration preflight', () => {
  it('produces a deterministic, read-only inventory for a coherent source', () => {
    const fixture = sourceFixture()
    const report = inspectLegacySite(fixture.root, fixture.site, '2026-07-30T00:00:00.000Z')

    expect(report).toEqual(
      expect.objectContaining({
        categoryCount: 1,
        generatedAt: '2026-07-30T00:00:00.000Z',
        issues: [],
        listingCount: 1,
        readyForMapping: true,
        siteId: 'example.com',
        supportingFiles: {
          assets: true,
          readme: true,
          siteConfig: true,
          siteContent: true
        },
        warnings: []
      })
    )
    expect(report.checksums.categories).toMatch(/^[a-f0-9]{64}$/u)
    expect(report.checksums.products).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('reports mismatched slugs and unresolved category memberships', () => {
    const fixture = sourceFixture()
    writeFileSync(
      resolve(fixture.root, 'sites', fixture.site, 'products.json'),
      JSON.stringify({
        'map-key': {
          product: {
            categories: ['missing-category'],
            productPage: 'not-a-url',
            slug: 'declared-slug',
            tagline: '',
            title: ''
          }
        }
      })
    )
    commitFixture(fixture.root)

    const report = inspectLegacySite(fixture.root, fixture.site)
    expect(report.readyForMapping).toBe(false)
    expect(report.issues).toEqual(
      expect.arrayContaining([
        'Product map-key declares mismatched slug declared-slug.',
        'Product map-key references missing category missing-category.',
        'Product map-key has an invalid productPage URL.',
        'Product map-key has no tagline.',
        'Product map-key has no title.'
      ])
    )
  })

  it('validates an omitted category through the checked-in trial adapter contract', () => {
    const fixture = sourceFixture()
    writeTrialAdapterConfig(fixture.root, fixture.site)
    writeFileSync(
      resolve(fixture.root, 'sites', fixture.site, 'products.json'),
      JSON.stringify({
        'example-tool': {
          product: {
            productPage: 'https://example.com/tool',
            slug: 'example-tool',
            tagline: 'A complete product description.',
            title: 'Example Tool'
          },
          content: { body: '## Overview\n\nUseful product.' }
        }
      })
    )
    commitFixture(fixture.root)

    const report = inspectLegacySite(fixture.root, fixture.site, '2026-07-30T00:00:00.000Z')

    expect(report.readyForMapping).toBe(true)
    expect(report.adapter).toEqual({
      defaultCategory: 'video-tools',
      featuredCount: 6,
      kind: 'trial-products-json',
      publishedAt: '2026-05-03'
    })
    expect(report.warnings).toContain(
      '1 products use trial-products-json default category video-tools.'
    )
  })

  it('rejects an adapter default category that is absent from taxonomy', () => {
    const fixture = sourceFixture()
    writeTrialAdapterConfig(fixture.root, fixture.site)
    writeFileSync(
      resolve(fixture.root, 'sites', fixture.site, 'categories.json'),
      JSON.stringify([{ slug: 'other', name: 'Other', description: 'Other products.' }])
    )
    writeFileSync(
      resolve(fixture.root, 'sites', fixture.site, 'products.json'),
      JSON.stringify({
        'example-tool': {
          product: {
            productPage: 'https://example.com/tool',
            slug: 'example-tool',
            tagline: 'A complete product description.',
            title: 'Example Tool'
          },
          content: { body: '## Overview\n\nUseful product.' }
        }
      })
    )
    commitFixture(fixture.root)

    const report = inspectLegacySite(fixture.root, fixture.site)

    expect(report.readyForMapping).toBe(false)
    expect(report.issues).toContain(
      'Product example-tool requires missing adapter default category video-tools.'
    )
  })

  it('rejects ambiguous or dynamic adapter configuration', () => {
    const fixture = sourceFixture()
    writeFileSync(
      resolve(fixture.root, 'sites', fixture.site, 'site-config.ts'),
      `const listingSource = {
        category: 'video-tools',
        featuredCount: 6,
        kind: 'trial-products-json',
        publishedAt: '2026-05-03'
      }
      export const config = { content: { listingSource } }\n`
    )
    commitFixture(fixture.root)

    const report = inspectLegacySite(fixture.root, fixture.site)

    expect(report.readyForMapping).toBe(false)
    expect(report.issues).toContain(
      'site config must contain exactly one static content.listingSource object for migration.'
    )
  })

  it('rejects an adapter-like object outside the exported site config', () => {
    const fixture = sourceFixture()
    writeFileSync(
      resolve(fixture.root, 'sites', fixture.site, 'site-config.ts'),
      `const unrelated = {
        content: {
          listingSource: {
            category: 'video-tools',
            featuredCount: 6,
            kind: 'trial-products-json',
            publishedAt: '2026-05-03'
          }
        }
      }
      export const config = { content: unrelated }\n`
    )
    commitFixture(fixture.root)

    const report = inspectLegacySite(fixture.root, fixture.site)

    expect(report.readyForMapping).toBe(false)
    expect(report.issues).toContain(
      'listingSource must be declared directly under the exported site config content object.'
    )
  })

  it('rejects invalid adapter dates and out-of-range featured counts', () => {
    const fixture = sourceFixture()
    writeFileSync(
      resolve(fixture.root, 'sites', fixture.site, 'site-config.ts'),
      `export const config = {
        content: {
          listingSource: {
            category: 'video-tools',
            featuredCount: 10001,
            kind: 'trial-products-json',
            publishedAt: '2026-02-31'
          }
        }
      }\n`
    )
    commitFixture(fixture.root)

    const report = inspectLegacySite(fixture.root, fixture.site)

    expect(report.readyForMapping).toBe(false)
    expect(report.issues).toContain(
      'trial-products-json content.listingSource must statically declare a valid category, featuredCount from 0 to 10000, and calendar publishedAt date.'
    )
  })

  it('rejects malformed TypeScript and unsupported source kinds', () => {
    const malformedFixture = sourceFixture()
    writeFileSync(
      resolve(malformedFixture.root, 'sites', malformedFixture.site, 'site-config.ts'),
      'export const config = { content: { listingSource: {'
    )
    commitFixture(malformedFixture.root)
    expect(inspectLegacySite(malformedFixture.root, malformedFixture.site).issues).toContain(
      'site config contains TypeScript syntax errors and cannot be inspected safely.'
    )

    const unsupportedFixture = sourceFixture()
    writeFileSync(
      resolve(unsupportedFixture.root, 'sites', unsupportedFixture.site, 'site-config.ts'),
      `export const config = {
        content: {
          listingSource: {
            kind: 'listing-json'
          }
        }
      }\n`
    )
    commitFixture(unsupportedFixture.root)
    expect(inspectLegacySite(unsupportedFixture.root, unsupportedFixture.site).issues).toContain(
      'Unsupported static content.listingSource kind for migration: listing-json.'
    )
  })
})

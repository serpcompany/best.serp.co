import { Linter } from 'eslint'
import { describe, expect, it } from 'vitest'
import noForbiddenListingLinks, {
  preserveTextLinesProcessor
} from './no-forbidden-listing-links.mjs'

function lintText(source: string, filename: string) {
  const linter = new Linter({ configType: 'flat' })
  const [processedSource] = preserveTextLinesProcessor.preprocess(source, filename)

  return linter.verify(
    processedSource,
    [
      {
        files: ['**/*.{html,js,jsx,json,jsonc,md,mdx,mjs,ts,tsx,txt,xml}'],
        languageOptions: {
          ecmaVersion: 'latest',
          sourceType: 'module'
        },
        plugins: {
          directory: {
            rules: {
              'no-forbidden-listing-links': noForbiddenListingLinks
            }
          }
        },
        rules: {
          'directory/no-forbidden-listing-links': 'error'
        }
      }
    ],
    { filename }
  )
}

describe('no-forbidden-listing-links', () => {
  it('reports help.serp.co/en links in D1 repository code', () => {
    const messages = lintText(
      'const supportUrl = "https://help.serp.co/en/"\n',
      'apps/serp.software/lib/catalog/repository.ts'
    )

    expect(messages).toEqual([
      expect.objectContaining({
        line: 1,
        message: expect.stringContaining('https://help.serp.co/en/'),
        ruleId: 'directory/no-forbidden-listing-links'
      })
    ])
  })

  it('reports help.serp.co/en links in application pages', () => {
    const messages = lintText(
      [
        'export default function Page() {',
        '  return <a href="https://help.serp.co/en/">Help</a>',
        '}'
      ].join('\n'),
      'apps/browserextensions.io/app/products/[slug]/page.tsx'
    )

    expect(messages).toHaveLength(1)
    expect(messages[0]?.line).toBe(2)
  })

  it('reports help.serp.co/en links in listing normalization code', () => {
    const messages = lintText(
      'const helpCenter = "https://help.serp.co/en/"\n',
      'packages/web-core/src/content-query.ts'
    )

    expect(messages).toHaveLength(1)
  })

  it('reports help.serp.co/en links in generated product html', () => {
    const messages = lintText(
      ['<html>', '<body><a href="https://help.serp.co/en/">Help</a></body>', '</html>'].join('\n'),
      'dist/sites/browserextensions.io/products/example-downloader/index.html'
    )

    expect(messages).toHaveLength(1)
    expect(messages[0]?.line).toBe(2)
  })

  it('reports help.serp.co/en links in generated xml and public text assets', () => {
    const generatedMessages = lintText(
      '<url><loc>https://help.serp.co/en/articles/example</loc></url>\n',
      'dist/sites/browserextensions.io/sitemap.xml'
    )
    const publicMessages = lintText(
      'Support: https://help.serp.co/en/\n',
      'apps/browserextensions.io/public/support.txt'
    )

    expect(generatedMessages).toHaveLength(1)
    expect(publicMessages).toHaveLength(1)
  })

  it('allows non-page test fixtures to mention the banned URL', () => {
    const messages = lintText(
      'const bannedFixture = "https://help.serp.co/en/"\n',
      'scripts/eslint-rules/no-forbidden-listing-links.test.ts'
    )

    expect(messages).toEqual([])
  })
})

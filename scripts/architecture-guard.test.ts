import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    encoding: 'utf8'
  })
    .split('\n')
    .filter(Boolean)
}

const forbiddenExactCatalogPaths = [
  ['data', 'listings.json'].join('/'),
  ['apps', 'serp.software', 'public', 'search', 'search-index.json'].join('/'),
  ['apps', 'pornvideodownloaders.com', 'public', 'search', 'search-index.json'].join('/')
]

const guardedSourceRoots = [
  'apps/serp.software/',
  'apps/pornvideodownloaders.com/',
  'packages/site-contract/',
  'packages/web-core/',
  'sites/',
  '.github/workflows/'
]

describe('D1-only repository architecture', () => {
  it('keeps the retired workspace package scope out of live files', () => {
    const retiredScope = ['@', 'thedaviddias', '/'].join('')
    const violations = trackedFiles().filter(file => {
      if (!existsSync(resolve(file))) return false
      return readFileSync(resolve(file), 'utf8').includes(retiredScope)
    })

    expect(violations).toEqual([])
  })

  it('contains no checked-in or generated catalog files', () => {
    const files = trackedFiles()
    const forbidden = files.filter(
      file =>
        forbiddenExactCatalogPaths.includes(file) ||
        /^sites\/[^/]+\/(?:products|categories)\.json$/u.test(file)
    )

    expect(forbidden).toEqual([])
    for (const file of forbiddenExactCatalogPaths) {
      expect(existsSync(resolve(file)), `${file} must not exist`).toBe(false)
    }
  })

  it('contains no file-backed catalog or static-directory runtime source kinds', () => {
    const forbiddenTokens = [
      ['listing', 'json'].join('-'),
      ['trial', 'products', 'json'].join('-'),
      ['github', 'pages', 'repo', 'sync'].join('-'),
      ['static', 'directory'].join('-')
    ]
    const violations: string[] = []

    for (const file of trackedFiles()) {
      if (
        !guardedSourceRoots.some(root => file.startsWith(root)) ||
        !/\.(?:jsonc?|mdx?|mjs|ts|tsx|ya?ml)$/u.test(file)
      ) {
        continue
      }
      if (!existsSync(resolve(file))) continue

      const source = readFileSync(resolve(file), 'utf8')
      for (const token of forbiddenTokens) {
        if (source.includes(token)) violations.push(`${file}: ${token}`)
      }
    }

    expect(violations).toEqual([])
  })

  it('keeps catalog access server-only and bound to D1', () => {
    for (const siteId of ['pornvideodownloaders.com', 'serp.software']) {
      const repository = readFileSync(resolve(`apps/${siteId}/lib/catalog/repository.ts`), 'utf8')
      const config = readFileSync(resolve(`sites/${siteId}/site-config.ts`), 'utf8')

      expect(repository).toContain("import 'server-only'")
      expect(repository).toContain('getCloudflareContext')
      expect(repository).toContain('env.DB')
      expect(repository).toContain('@serpdirectory/data-ops/catalog')
      expect(repository).toContain("from '@serpdirectory/data-ops/client'")
      expect(repository).toContain(
        'createSiteDatabase(assertCatalogBinding(cloudflareEnv), siteId)'
      )
      expect(repository).toContain('readListingBySlug = cache(')
      expect(repository).not.toMatch(/\b(?:SELECT|WITH)\b/u)
      expect(repository).not.toMatch(/node:fs|readFile|writeFile/u)
      expect(config).toContain("kind: 'd1-listings'")
      expect(config).toContain("binding: 'DB'")
    }
    const sharedOperations = readFileSync(resolve('packages/data-ops/src/catalog.ts'), 'utf8')
    expect(sharedOperations).toContain('createCatalogOperations')
    expect(sharedOperations).toContain('runSiteQuery')
    expect(sharedOperations).toContain('statement: CompiledSiteQuery | SQL<T>')
    expect(sharedOperations).not.toContain('query: CompiledSiteQuery | SQL<T> | string')
    expect(sharedOperations).toContain('siteId')
    expect(sharedOperations).not.toContain('.prepare(')
    expect(sharedOperations).not.toContain('getCloudflareContext')
    expect(sharedOperations).not.toContain('process.env')
  })

  it('owns the only Drizzle schema and client in the shared data package', () => {
    const files = trackedFiles()
    const schemaOrClientFiles = files.filter(
      file => existsSync(resolve(file)) && /(?:^|\/)(?:schema|client)\.ts$/u.test(file)
    )
    const drizzleSources = files.filter(file => {
      if (
        file === 'scripts/architecture-guard.test.ts' ||
        !/\.(?:ts|tsx)$/u.test(file) ||
        !existsSync(resolve(file))
      )
        return false
      return readFileSync(resolve(file), 'utf8').includes('drizzle-orm')
    })

    expect(schemaOrClientFiles).not.toContain('apps/serp.software/lib/catalog/schema.ts')
    expect(schemaOrClientFiles).not.toContain('apps/pornvideodownloaders.com/lib/catalog/schema.ts')
    expect(drizzleSources.every(file => file.startsWith('packages/data-ops/'))).toBe(true)
    expect(files).toContain('packages/data-ops/src/schema.ts')
    expect(files).toContain('packages/data-ops/src/client.ts')

    for (const siteId of ['pornvideodownloaders.com', 'serp.software']) {
      const manifest = JSON.parse(readFileSync(resolve(`apps/${siteId}/package.json`), 'utf8')) as {
        dependencies?: Record<string, string>
      }
      expect(manifest.dependencies?.['drizzle-orm']).toBeUndefined()
    }
    const dataOpsManifest = JSON.parse(
      readFileSync(resolve('packages/data-ops/package.json'), 'utf8')
    ) as { dependencies?: Record<string, string> }
    expect(dataOpsManifest.dependencies?.['drizzle-orm']).toMatch(/^\d+\.\d+\.\d+$/u)

    const client = readFileSync(resolve('packages/data-ops/src/client.ts'), 'utf8')
    expect(client).toContain('binding: D1Database')
    expect(client).toContain('siteId: ActiveCheckedInSiteId')
    expect(client).toContain('assertSiteIdIsSupported(siteId)')
    expect(client).not.toMatch(/getCloudflareContext|process\.env/u)

    const contracts = readFileSync(resolve('packages/data-ops/src/contracts.ts'), 'utf8')
    expect(contracts).toContain('client: SiteDatabase')
    expect(contracts).not.toContain('database: D1Database')
  })

  it('keeps Submission SQL and conditional mutation plans in the shared data package', () => {
    for (const siteId of ['pornvideodownloaders.com', 'serp.software']) {
      for (const file of ['repository.ts', 'review-preview-repository.ts']) {
        const adapter = readFileSync(resolve(`apps/${siteId}/lib/submissions/${file}`), 'utf8')
        expect(adapter).toContain('@serpdirectory/data-ops/submissions')
        expect(adapter).toContain('createSiteDatabase(workerEnv.DB, siteId)')
        expect(adapter).not.toMatch(/\b(?:SELECT|INSERT|UPDATE|DELETE|WITH)\b/u)
        expect(adapter).not.toContain('.prepare(')
        expect(adapter).not.toContain('.batch(')
      }
    }

    const operations = readFileSync(resolve('packages/data-ops/src/submissions.ts'), 'utf8')
    const plans = readFileSync(resolve('packages/data-ops/src/submission-plans.ts'), 'utf8')
    expect(operations).toContain('createSubmissionOperations')
    expect(operations).toContain('client: SiteDatabase')
    expect(operations).toContain("from './public-url'")
    expect(operations).toContain('buildSubmissionReviewPreview')
    expect(operations).not.toMatch(/\bTEMP\b/iu)
    expect(plans).not.toMatch(/\bTEMP\b/iu)
    expect(plans).toContain("CASE WHEN changes()=1 THEN 1 ELSE json_extract('', '$') END")
    expect(`${operations}\n${plans}`).not.toMatch(
      /getCloudflareContext|process\.env|CLOUDFLARE_API_TOKEN|GITHUB_TOKEN|api\.cloudflare\.com/u
    )

    const approver = readFileSync(resolve('scripts/d1-submission-approver.ts'), 'utf8')
    const notifier = readFileSync(resolve('scripts/d1-submission-notifier.ts'), 'utf8')
    expect(approver).toContain('@serpdirectory/data-ops/submission-plans')
    expect(notifier).toContain('@serpdirectory/data-ops/submission-plans')
    expect(approver).toContain('validateApprovalContext')
    expect(notifier).toContain('validateNotificationContext')

    for (const siteId of ['pornvideodownloaders.com', 'serp.software']) {
      expect(existsSync(resolve(`apps/${siteId}/lib/url-safety.ts`))).toBe(false)
      const verifier = readFileSync(
        resolve(`apps/${siteId}/lib/submissions/badge-verifier.ts`),
        'utf8'
      )
      expect(verifier).toContain('@serpdirectory/data-ops/public-url')
    }
    const publicUrl = readFileSync(resolve('packages/data-ops/src/public-url.ts'), 'utf8')
    expect(publicUrl).toContain('validatePublicHttpUrl')
    expect(publicUrl).not.toMatch(/getCloudflareContext|process\.env|node:net/u)
  })

  it('keeps fresh Drizzle migrations isolated and forbids push-based schema mutation', () => {
    const config = readFileSync(resolve('drizzle.config.ts'), 'utf8')
    expect(config).toContain("out: './d1/drizzle'")
    expect(config).not.toContain('d1/migrations')

    const guardedFiles = trackedFiles().filter(
      file =>
        (file === 'package.json' ||
          file.startsWith('scripts/') ||
          file.startsWith('.github/workflows/')) &&
        existsSync(resolve(file))
    )
    const pushViolations = guardedFiles.filter(file =>
      /drizzle-kit\s+push/u.test(readFileSync(resolve(file), 'utf8'))
    )
    expect(pushViolations).toEqual([])
  })

  it('keeps retired public static repositories out of live application links', () => {
    const pornVideoDownloadersConfig = readFileSync(
      resolve('sites/pornvideodownloaders.com/site-config.ts'),
      'utf8'
    )
    const pornVideoDownloadersNotFound = readFileSync(
      resolve('apps/pornvideodownloaders.com/app/not-found.tsx'),
      'utf8'
    )
    const serpCookiePolicy = readFileSync(
      resolve('packages/content/data/legal/cookies.mdx'),
      'utf8'
    )

    expect(pornVideoDownloadersConfig).toContain('githubIssueOwner: null')
    expect(pornVideoDownloadersConfig).toContain('githubIssueRepo: null')
    expect(pornVideoDownloadersConfig).toContain('githubIssuesUrl: null')
    expect(pornVideoDownloadersConfig).not.toContain(
      'github.com/serpcompany/pornvideodownloaders.com'
    )
    expect(pornVideoDownloadersNotFound).not.toMatch(/GitHub|githubIssuesUrl/u)
    expect(serpCookiePolicy).not.toContain('github.com/serpcompany/serp.software')
  })
})

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { project } from './project'

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    encoding: 'utf8'
  })
    .split('\n')
    .filter(Boolean)
}

const forbiddenExactCatalogPaths = [
  ['data', 'listings.json'].join('/'),
  [project.appDirectory, 'public', 'search', 'search-index.json'].join('/')
]

const guardedSourceRoots = [
  `${project.appDirectory}/`,
  'packages/site-config/',
  'packages/web-core/',
  '.github/workflows/'
]

const sharedDataOperations = [
  'packages/data-ops/src/catalog.ts',
  'packages/data-ops/src/client.ts',
  'packages/data-ops/src/contracts.ts',
  'packages/data-ops/src/email-deliveries.ts',
  'packages/data-ops/src/schema.ts',
  'packages/data-ops/src/submission-plans.ts',
  'packages/data-ops/src/submissions.ts'
]

describe('single-site D1-only repository architecture', () => {
  it('builds exactly one web application from one checked-in site config', () => {
    const appDirectories = readdirSync(resolve('apps'), { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort()
    expect(appDirectories).toEqual(['e2e', 'web'])
    expect(project.appDirectory).toBe('apps/web')

    const appManifest = JSON.parse(
      readFileSync(resolve(project.appDirectory, 'package.json'), 'utf8')
    ) as { dependencies?: Record<string, string>; name?: string }
    expect(appManifest.name).toBe(project.appPackageName)
    expect(appManifest.dependencies?.['@serpdirectory/site-config']).toBe('workspace:*')
    expect(appManifest.dependencies?.['@serpdirectory/site-contract']).toBeUndefined()

    expect(existsSync(resolve('packages/site-config/src/site.ts'))).toBe(true)
    for (const retired of ['packages/site-contract', 'sites', 'configs/wrangler']) {
      expect(existsSync(resolve(retired)), `${retired} must stay retired`).toBe(false)
    }
    const siteConfig = readFileSync(resolve('packages/site-config/src/site.ts'), 'utf8')
    expect(siteConfig).toContain(`id: '${project.domain}'`)
    expect(siteConfig).not.toMatch(/listingSource|appPackageName|artifactDir/u)
  })

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
    const forbidden = files.filter(file => forbiddenExactCatalogPaths.includes(file))

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
    const repository = readFileSync(
      resolve(project.appDirectory, 'lib/catalog/repository.ts'),
      'utf8'
    )

    expect(repository).toContain("import 'server-only'")
    expect(repository).toContain('getCloudflareContext')
    expect(repository).toContain('env.DB')
    expect(repository).toContain('@serpdirectory/data-ops/catalog')
    expect(repository).toContain("from '@serpdirectory/data-ops/client'")
    expect(repository).toContain('createDatabase(assertCatalogBinding(cloudflareEnv))')
    expect(repository).toContain('readListingBySlug = cache(')
    expect(repository).not.toMatch(/\b(?:SELECT|WITH)\b/u)
    expect(repository).not.toMatch(/node:fs|readFile|writeFile/u)

    const wrangler = JSON.parse(readFileSync(resolve(project.wranglerConfigPath), 'utf8')) as {
      d1_databases?: Array<{ binding?: string }>
    }
    expect(wrangler.d1_databases?.map(binding => binding.binding)).toEqual(['DB'])

    const sharedOperations = readFileSync(resolve('packages/data-ops/src/catalog.ts'), 'utf8')
    expect(sharedOperations).toContain('createCatalogOperations')
    expect(sharedOperations).toContain('runQuery')
    expect(sharedOperations).toContain('statement: CompiledQuery | SQL<T>')
    expect(sharedOperations).not.toContain('query: CompiledQuery | SQL<T> | string')
    expect(sharedOperations).not.toContain('.prepare(')
    expect(sharedOperations).not.toContain('getCloudflareContext')
    expect(sharedOperations).not.toContain('process.env')
  })

  it('keeps shared data operations free of tenant scoping', () => {
    for (const file of sharedDataOperations) {
      const source = readFileSync(resolve(file), 'utf8')
      expect(source, file).not.toMatch(/\bsite_id\b|\bsiteId\b|SiteDatabase|\bsites\b/u)
    }
    const schema = readFileSync(resolve('packages/data-ops/src/schema.ts'), 'utf8')
    expect(schema).toContain("'publication_state'")
    expect(schema).toContain('publication_state_singleton')
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

    expect(schemaOrClientFiles).not.toContain(`${project.appDirectory}/lib/catalog/schema.ts`)
    expect(drizzleSources.every(file => file.startsWith('packages/data-ops/'))).toBe(true)
    expect(files).toContain('packages/data-ops/src/schema.ts')
    expect(files).toContain('packages/data-ops/src/client.ts')

    const manifest = JSON.parse(
      readFileSync(resolve(project.appDirectory, 'package.json'), 'utf8')
    ) as {
      dependencies?: Record<string, string>
    }
    expect(manifest.dependencies?.['drizzle-orm']).toBeUndefined()
    const dataOpsManifest = JSON.parse(
      readFileSync(resolve('packages/data-ops/package.json'), 'utf8')
    ) as { dependencies?: Record<string, string> }
    expect(dataOpsManifest.dependencies?.['drizzle-orm']).toMatch(/^\d+\.\d+\.\d+$/u)

    const client = readFileSync(resolve('packages/data-ops/src/client.ts'), 'utf8')
    expect(client).toContain('binding: D1Database')
    expect(client).toContain('export function createDatabase(binding: D1Database): Database')
    expect(client).not.toMatch(/getCloudflareContext|process\.env/u)

    const contracts = readFileSync(resolve('packages/data-ops/src/contracts.ts'), 'utf8')
    expect(contracts).toContain('client: Database')
    expect(contracts).not.toContain('database: D1Database')
  })

  it('keeps email delivery SQL in the shared data package behind a fail-closed adapter', () => {
    const runtime = readFileSync(resolve(project.appDirectory, 'lib/email/runtime.ts'), 'utf8')
    const policy = runtime.indexOf('resolveEmailPolicy(env)')
    expect(policy).toBeGreaterThan(-1)
    expect(runtime.indexOf('createDatabase(env.DB)')).toBeGreaterThan(policy)
    expect(runtime).toContain("from '@serpdirectory/data-ops/client'")
    expect(runtime).toContain("from '@serpdirectory/data-ops/email-deliveries'")
    expect(runtime).toContain('createDisabledEmailService')

    const emailDirectory = resolve(project.appDirectory, 'lib/email')
    for (const file of readdirSync(emailDirectory).filter(name => /\.tsx?$/u.test(name))) {
      const code = readFileSync(resolve(emailDirectory, file), 'utf8')
      if (file.endsWith('.test.ts')) continue
      expect(code, file).not.toMatch(/\b(?:SELECT|INSERT|UPDATE|DELETE|WITH)\b/u)
      expect(code, file).not.toMatch(/\.prepare\(|\.batch\(|drizzle-orm/u)
    }

    const ledger = readFileSync(resolve('packages/data-ops/src/email-deliveries.ts'), 'utf8')
    expect(ledger).toContain('createEmailDeliveryLedger')
    expect(ledger).toContain('client: Database')
    expect(ledger).not.toMatch(/getCloudflareContext|process\.env|sql\.raw/u)
  })

  it('keeps Submission SQL and conditional mutation plans in the shared data package', () => {
    for (const file of ['repository.ts', 'review-preview-repository.ts']) {
      const adapter = readFileSync(resolve(project.appDirectory, 'lib/submissions', file), 'utf8')
      expect(adapter).toContain('@serpdirectory/data-ops/submissions')
      expect(adapter).toContain('createDatabase(workerEnv.DB)')
      expect(adapter).not.toMatch(/\b(?:SELECT|INSERT|UPDATE|DELETE|WITH)\b/u)
      expect(adapter).not.toContain('.prepare(')
      expect(adapter).not.toContain('.batch(')
    }

    const operations = readFileSync(resolve('packages/data-ops/src/submissions.ts'), 'utf8')
    const plans = readFileSync(resolve('packages/data-ops/src/submission-plans.ts'), 'utf8')
    expect(operations).toContain('createSubmissionOperations')
    expect(operations).toContain('client: Database')
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

    expect(existsSync(resolve(project.appDirectory, 'lib/url-safety.ts'))).toBe(false)
    const verifier = readFileSync(
      resolve(project.appDirectory, 'lib/submissions/badge-verifier.ts'),
      'utf8'
    )
    expect(verifier).toContain('@serpdirectory/data-ops/public-url')
    const publicUrl = readFileSync(resolve('packages/data-ops/src/public-url.ts'), 'utf8')
    expect(publicUrl).toContain('validatePublicHttpUrl')
    expect(publicUrl).not.toMatch(/getCloudflareContext|process\.env|node:net/u)
  })

  it('keeps accounts on Better Auth with their SQL in the shared data package', () => {
    const sources = trackedFiles().filter(
      file =>
        file !== 'scripts/architecture-guard.test.ts' &&
        /\.(?:jsonc?|m?[jt]sx?)$/u.test(file) &&
        existsSync(resolve(file))
    )
    const retiredAuth = [
      ['next', 'auth'].join('-'),
      ['@auth', 'core'].join('/'),
      'NEXTAUTH_',
      'AUTH_TRUST_HOST',
      ['GITHUB', 'CLIENT', 'ID'].join('_'),
      ['GITHUB', 'CLIENT', 'SECRET'].join('_')
    ]
    const authJs = sources.filter(file => {
      const source = readFileSync(resolve(file), 'utf8')
      return retiredAuth.some(token => source.includes(token))
    })
    expect(authJs).toEqual([])

    const authDirectory = resolve(project.appDirectory, 'lib/auth')
    for (const file of readdirSync(authDirectory).filter(name => !name.includes('.test.'))) {
      const source = readFileSync(resolve(authDirectory, file), 'utf8')
      expect(source, file).not.toMatch(/\b(?:SELECT|INSERT|UPDATE|DELETE)\b|\.prepare\(|\.batch\(/u)
    }
    const server = readFileSync(resolve(authDirectory, 'server.ts'), 'utf8')
    expect(server).toContain("import 'server-only'")
    expect(server).toContain('getCloudflareContext')
    expect(server).toContain('createDatabase(binding)')
    const operations = readFileSync(resolve('packages/data-ops/src/auth.ts'), 'utf8')
    expect(operations).not.toMatch(/getCloudflareContext|process\.env/u)
  })

  it('makes every admin page and admin API route require an admin', () => {
    const adminRoutes = trackedFiles().filter(
      file =>
        (file.startsWith(`${project.appDirectory}/app/admin/`) ||
          file.startsWith(`${project.appDirectory}/app/api/admin/`)) &&
        /(?:^|\/)(?:page|route|layout)\.tsx?$/u.test(file) &&
        existsSync(resolve(file))
    )
    expect(adminRoutes).toEqual(
      expect.arrayContaining([
        `${project.appDirectory}/app/admin/route.ts`,
        `${project.appDirectory}/app/admin/[...path]/page.tsx`,
        `${project.appDirectory}/app/api/admin/[[...path]]/route.ts`
      ])
    )
    for (const file of adminRoutes) {
      const source = readFileSync(resolve(file), 'utf8')
      expect(source, `${file} must call requireAdmin() or authorizeAdminRequest()`).toMatch(
        /await (?:requireAdmin|authorizeAdminRequest)\(/u
      )
    }
  })

  // A Server Action is reachable by its action id from any page path, so no path-based gate
  // (the Worker's /admin lock included) ever sees it, and each action must authorize itself.
  // Until the admin panel (#64) settles how, no module the app bundles may declare one.
  it('keeps Server Actions out of the app until #64 decides how they authorize', () => {
    const violations = trackedFiles().filter(file => {
      if (
        !(file.startsWith(`${project.appDirectory}/`) || file.startsWith('packages/')) ||
        !/\.(?:m?[jt]sx?)$/u.test(file) ||
        !existsSync(resolve(file))
      )
        return false
      return /^\s*['"]use server['"]/mu.test(readFileSync(resolve(file), 'utf8'))
    })
    expect(violations).toEqual([])
  })

  it('keeps one fresh Drizzle migration history and forbids push-based schema mutation', () => {
    const config = readFileSync(resolve('drizzle.config.ts'), 'utf8')
    expect(config).toContain("out: './d1/drizzle'")
    expect(config).not.toContain('d1/migrations')
    expect(existsSync(resolve('d1/migrations'))).toBe(false)

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

  it('keeps retired multi-site tooling out of repository scripts', () => {
    const retiredScripts = [
      'scripts/site-targets.ts',
      'scripts/worker-release.ts',
      'scripts/d1-replatform.ts',
      'scripts/d1-replatform-inventory.ts',
      'scripts/d1-replatform-cutover.ts'
    ]
    for (const file of retiredScripts) {
      expect(existsSync(resolve(file)), `${file} must stay deleted`).toBe(false)
    }
    const violations = trackedFiles()
      .filter(
        file =>
          file.startsWith('scripts/') &&
          !file.startsWith('scripts/migration/') &&
          file !== 'scripts/migration-preflight.test.ts' &&
          file !== 'scripts/architecture-guard.test.ts' &&
          /\.(?:m?js|ts)$/u.test(file) &&
          existsSync(resolve(file))
      )
      .filter(file =>
        /site-targets|resolveSiteTarget|cutover-lock|D1_RELEASE_GENERATION|DEPLOY_SITE_ID|d1-replatform/u.test(
          readFileSync(resolve(file), 'utf8')
        )
      )
    expect(violations).toEqual([])
  })

  it('keeps retired public static repositories out of live application links', () => {
    const siteConfig = readFileSync(resolve('packages/site-config/src/site.ts'), 'utf8')
    const cookiePolicy = readFileSync(resolve('packages/content/data/legal/cookies.mdx'), 'utf8')

    expect(siteConfig).toContain('githubIssueOwner: null')
    expect(siteConfig).toContain('githubIssueRepo: null')
    expect(siteConfig).toContain('githubIssuesUrl: null')
    expect(siteConfig).not.toMatch(
      /github\.com\/serpcompany\/(?:serp\.software|pornvideodownloaders)/u
    )
    expect(cookiePolicy).not.toContain('github.com/serpcompany/serp.software')
  })
})

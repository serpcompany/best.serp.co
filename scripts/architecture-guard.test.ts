import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import {
  D1_MAX_FUNCTION_ARGUMENTS,
  d1StatementLimitViolations,
  maxFunctionArguments,
  oversizedPatternLiterals,
  stripSqlLiteralsAndComments
} from '../apps/web/src/db/sql-limits'
import { project } from './project'

/** Drizzle's pattern helpers: they build a LIKE from a bound value without SQL text. */
const DRIZZLE_PATTERN_HELPERS = new Set(['like', 'notLike', 'ilike', 'notIlike'])
/**
 * Reviewed uses of those helpers, as `file:helper` -> why its pattern is bounded to 50 bytes.
 * Empty: search matches with `instr()` (#77).
 */
const ALLOWED_DRIZZLE_PATTERN_HELPERS: Readonly<Record<string, string>> = {}
/** What ends the right operand of LIKE/GLOB at the top level of an expression. */
const PATTERN_OPERAND_END =
  /^(?:AND|OR|ESCAPE|THEN|WHEN|ELSE|END|WHERE|ORDER|GROUP|HAVING|LIMIT|UNION|FROM|AS)\b/iu

/**
 * True when a LIKE or GLOB in `text` (any case; operator form `x LIKE …` or function form
 * `like(…)`) takes a bound value (`?`, which also stands for any `${…}`) anywhere in its
 * pattern operand: `LIKE ?`, `LIKE (?)`, `LIKE '%' || ? || '%'`, `like(?, x)`.
 */
function likeTakesBoundValue(text: string): boolean {
  const code = stripSqlLiteralsAndComments(text)
  for (const match of code.matchAll(/\b(?:LIKE|GLOB)\b/giu)) {
    const start = match.index ?? 0
    // Operator form follows an operand (`name LIKE`, `) NOT GLOB`); function form opens a call.
    const operatorForm = /[\w)'"?\]]\s+$/u.test(code.slice(0, start))
    const functionForm = /^\s*\(/u.test(code.slice(start + match[0].length))
    if (!operatorForm && !functionForm) continue
    let depth = 0
    let operand = ''
    for (let index = start + match[0].length; index < code.length; index++) {
      const character = code[index] ?? ''
      if (depth === 0 && operand.trim() && PATTERN_OPERAND_END.test(code.slice(index))) break
      if (character === '(') depth++
      else if (character === ')') {
        if (depth === 0) break
        depth--
      } else if (character === ',' && depth === 0) break
      operand += character
    }
    if (operand.includes('?')) return true
  }
  return false
}

/**
 * LIKE/GLOB and function-argument violations in one TypeScript source: every string and
 * template literal is checked for a bound or concatenated pattern (any case, no keyword gate),
 * literal patterns over 50 bytes, and SQL functions over 32 arguments; Drizzle's pattern
 * helpers are refused unless reviewed (`ALLOWED_DRIZZLE_PATTERN_HELPERS`).
 */
function sqlSourceViolations(file: string, sourceText: string): string[] {
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true)
  const violations: string[] = []
  const lineOf = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart()).line + 1
  const drizzleNamespaces = new Set<string>()
  const refuseHelper = (node: ts.Node, helper: string) => {
    if (!DRIZZLE_PATTERN_HELPERS.has(helper)) return
    if (ALLOWED_DRIZZLE_PATTERN_HELPERS[`${file}:${helper}`]) return
    violations.push(`${file}:${lineOf(node)}: Drizzle ${helper}() builds an unbounded LIKE pattern`)
  }
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      /^drizzle-orm(?:\/|$)/u.test(node.moduleSpecifier.text)
    ) {
      const bindings = node.importClause?.namedBindings
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          refuseHelper(element, (element.propertyName ?? element.name).text)
        }
      } else if (bindings && ts.isNamespaceImport(bindings)) {
        drizzleNamespaces.add(bindings.name.text)
      }
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      drizzleNamespaces.has(node.expression.text)
    ) {
      refuseHelper(node, node.name.text)
    }
    let text: string | null = null
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) text = node.text
    else if (ts.isTemplateExpression(node)) {
      text = node.head.text + node.templateSpans.map(span => `?${span.literal.text}`).join('')
    }
    if (text) {
      const where = `${file}:${lineOf(node)}`
      if (likeTakesBoundValue(text)) {
        violations.push(`${where}: LIKE/GLOB takes a bound or concatenated pattern`)
      }
      for (const pattern of oversizedPatternLiterals(text)) {
        violations.push(`${where}: LIKE/GLOB pattern over 50 bytes: ${pattern}`)
      }
      if (/\b(?:SELECT|INSERT|UPDATE|DELETE|CREATE|WITH)\b/iu.test(text)) {
        const widest = maxFunctionArguments(text)
        if (widest && widest.count > D1_MAX_FUNCTION_ARGUMENTS) {
          violations.push(`${where}: ${widest.name}() has ${widest.count} arguments`)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return violations
}

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

const guardedSourceRoots = [`${project.appDirectory}/`, '.github/workflows/']

const sharedDataOperations = [
  'apps/web/src/db/catalog.ts',
  'apps/web/src/db/client.ts',
  'apps/web/src/db/contracts.ts',
  'apps/web/src/db/email-deliveries.ts',
  'apps/web/src/db/schema.ts',
  'apps/web/src/db/submission-plans.ts',
  'apps/web/src/db/submissions.ts'
]

/**
 * SQL that writes `badge_checks` (any quoting, `INSERT OR …`, `REPLACE`), or a Drizzle
 * `insert`/`update`/`delete` of the `badgeChecks` table.
 */
function writesBadgeChecks(source: string): boolean {
  const table = String.raw`["'\x60\[]?badge_checks["'\x60\]]?(?![\w])`
  return (
    new RegExp(
      String.raw`\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+${table}`,
      'iu'
    ).test(source) || /\.(?:insert|update|delete)\(\s*(?:\w+\.)?badgeChecks\b/u.test(source)
  )
}

describe('single-site D1-only repository architecture', () => {
  it('builds exactly one web application from one checked-in site config', () => {
    // Committed files only: a checkout from before #177 keeps its old apps/e2e/test-results/.
    const appDirectories = [
      ...new Set(
        execFileSync('git', ['ls-files', '--cached', 'apps'], { encoding: 'utf8' })
          .split('\n')
          .filter(Boolean)
          .map(file => file.split('/')[1])
      )
    ].sort()
    expect(appDirectories).toEqual(['web'])
    expect(project.appDirectory).toBe('apps/web')
    // Next.js prefers apps/web/app over src/app: a leftover folder would build with no routes.
    for (const folder of ['app', 'components', 'lib', 'actions', 'hooks']) {
      expect(existsSync(resolve(project.appDirectory, folder)), folder).toBe(false)
    }
    expect(project.sourceDirectory).toBe('apps/web/src')

    const appManifest = JSON.parse(
      readFileSync(resolve(project.appDirectory, 'package.json'), 'utf8')
    ) as { dependencies?: Record<string, string>; name?: string }
    expect(appManifest.name).toBe(project.appPackageName)
    // The site definition lives in the app (#173), not a package.
    expect(appManifest.dependencies?.['@serpdirectory/site-config']).toBeUndefined()
    expect(appManifest.dependencies?.['@serpdirectory/site-contract']).toBeUndefined()

    expect(existsSync(resolve('apps/web/src/lib/site/site.ts'))).toBe(true)
    for (const retired of ['packages/site-contract', 'sites', 'configs/wrangler']) {
      expect(existsSync(resolve(retired)), `${retired} must stay retired`).toBe(false)
    }
    const siteConfig = readFileSync(resolve('apps/web/src/lib/site/site.ts'), 'utf8')
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
      resolve(project.sourceDirectory, 'lib/catalog/repository.ts'),
      'utf8'
    )

    expect(repository).toContain("import 'server-only'")
    expect(repository).toContain('getCloudflareContext')
    expect(repository).toContain('env.DB')
    expect(repository).toContain('@/db/catalog')
    expect(repository).toContain("from '@/db/client'")
    expect(repository).toContain('createDatabase(assertCatalogBinding(cloudflareEnv))')
    expect(repository).toContain('readListingBySlug = cache(')
    expect(repository).not.toMatch(/\b(?:SELECT|WITH)\b/u)
    expect(repository).not.toMatch(/node:fs|readFile|writeFile/u)

    const wrangler = JSON.parse(readFileSync(resolve(project.wranglerConfigPath), 'utf8')) as {
      d1_databases?: Array<{ binding?: string }>
    }
    expect(wrangler.d1_databases?.map(binding => binding.binding)).toEqual(['DB'])

    const sharedOperations = readFileSync(resolve('apps/web/src/db/catalog.ts'), 'utf8')
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
    const schema = readFileSync(resolve('apps/web/src/db/schema.ts'), 'utf8')
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

    expect(schemaOrClientFiles).not.toContain(`${project.sourceDirectory}/lib/catalog/schema.ts`)
    expect(drizzleSources.every(file => file.startsWith('apps/web/src/db/'))).toBe(true)
    expect(files).toContain('apps/web/src/db/schema.ts')
    expect(files).toContain('apps/web/src/db/client.ts')

    const manifest = JSON.parse(
      readFileSync(resolve(project.appDirectory, 'package.json'), 'utf8')
    ) as {
      dependencies?: Record<string, string>
    }
    expect(manifest.dependencies?.['drizzle-orm']).toMatch(/^\d+\.\d+\.\d+$/u)

    const client = readFileSync(resolve('apps/web/src/db/client.ts'), 'utf8')
    expect(client).toContain('binding: D1Database')
    expect(client).toContain('export function createDatabase(binding: D1Database): Database')
    expect(client).not.toMatch(/getCloudflareContext|process\.env/u)

    const contracts = readFileSync(resolve('apps/web/src/db/contracts.ts'), 'utf8')
    expect(contracts).toContain('client: Database')
    expect(contracts).not.toContain('database: D1Database')
  })

  it('keeps email delivery SQL in the shared data package behind a fail-closed adapter', () => {
    const runtime = readFileSync(resolve(project.sourceDirectory, 'lib/email/runtime.ts'), 'utf8')
    // The environment policy, then the DB binding check, then the only database client.
    const policy = runtime.indexOf('resolveEmailPolicy(env)')
    const binding = runtime.indexOf('if (!env.DB) throw')
    expect(policy).toBeGreaterThan(-1)
    expect(binding).toBeGreaterThan(policy)
    expect(runtime.indexOf('createDatabase(')).toBeGreaterThan(binding)
    expect(runtime.match(/createDatabase\(/gu)).toHaveLength(1)
    expect(runtime).toContain("from '@/db/client'")
    expect(runtime).toContain("from '@/db/email-deliveries'")
    expect(runtime).toContain('createDisabledEmailService')

    const emailDirectory = resolve(project.sourceDirectory, 'lib/email')
    for (const file of readdirSync(emailDirectory).filter(name => /\.tsx?$/u.test(name))) {
      const code = readFileSync(resolve(emailDirectory, file), 'utf8')
      if (file.endsWith('.test.ts')) continue
      expect(code, file).not.toMatch(/\b(?:SELECT|INSERT|UPDATE|DELETE|WITH)\b/u)
      expect(code, file).not.toMatch(/\.prepare\(|\.batch\(|drizzle-orm/u)
    }

    const ledger = readFileSync(resolve('apps/web/src/db/email-deliveries.ts'), 'utf8')
    expect(ledger).toContain('createEmailDeliveryLedger')
    expect(ledger).toContain('client: Database')
    expect(ledger).not.toMatch(/getCloudflareContext|process\.env|sql\.raw/u)
  })

  it('keeps Submission SQL and conditional mutation plans in the shared data package', () => {
    const adapter = readFileSync(
      resolve(project.sourceDirectory, 'lib/submissions/repository.ts'),
      'utf8'
    )
    expect(adapter).toContain('@/db/submissions')
    expect(adapter).toContain('createDatabase(workerEnv.DB)')
    expect(adapter).not.toMatch(/\b(?:SELECT|INSERT|UPDATE|DELETE|WITH)\b/u)
    expect(adapter).not.toContain('.prepare(')
    expect(adapter).not.toContain('.batch(')

    const operations = readFileSync(resolve('apps/web/src/db/submissions.ts'), 'utf8')
    // Statement plans (#62): submissions, listings, revisions, and their shared support.
    const plans = [
      'submission-plans',
      'draft-plans',
      'listing-plans',
      'revision-plans',
      'plan-support'
    ]
      .map(name => readFileSync(resolve(`apps/web/src/db/${name}.ts`), 'utf8'))
      .join('\n')
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

    expect(existsSync(resolve(project.sourceDirectory, 'lib/url-safety.ts'))).toBe(false)
    // Every fetch of a submitter's URL (badge checks, prefill, logos) and of listing media goes
    // through the one shared safe fetcher, which validates each hop with the public-URL policy
    // (#95 moved submit v2's copy into the data layer, now `src/db`).
    expect(existsSync(resolve(project.sourceDirectory, 'lib/submissions/safe-fetch.ts'))).toBe(
      false
    )
    const safeFetch = readFileSync(resolve('apps/web/src/db/safe-fetch.ts'), 'utf8')
    expect(safeFetch).toContain("from './public-url'")
    expect(safeFetch).toContain("from './mime-type'")
    expect(safeFetch).toContain("redirect: 'manual'")
    for (const file of ['badge-verifier.ts', 'prefill.ts']) {
      const source = readFileSync(resolve(project.sourceDirectory, 'lib/submissions', file), 'utf8')
      expect(source, file).toMatch(/from '(?:@|\.\.\/\.\.)\/db\/safe-fetch'/u)
      expect(source, file).not.toMatch(/\bfetcher\(|\bawait fetch\(/u)
    }
    const ingest = readFileSync(resolve('apps/web/src/db/media-ingest.ts'), 'utf8')
    expect(ingest).toContain("from './safe-fetch'")
    expect(ingest).not.toMatch(/\bfetcher\(|\bawait fetch\(/u)
    // The site parser has one copy, in `src/db`; prefill re-exports it.
    expect(
      readFileSync(resolve(project.sourceDirectory, 'lib/submissions/prefill.ts'), 'utf8')
    ).not.toMatch(/function parseSiteMetadata|const NAMED_ENTITIES/u)
    // Only the media adapter touches the R2 binding; everything else goes through it.
    const mediaBindingUsers = trackedFiles().filter(
      file =>
        file.startsWith('apps/web/') &&
        /\.(?:m?[jt]sx?)$/u.test(file) &&
        !/\.test\.[jt]sx?$/u.test(file) &&
        existsSync(resolve(file)) &&
        /\benv\.MEDIA\b|\.MEDIA\??\./u.test(readFileSync(resolve(file), 'utf8'))
    )
    expect(mediaBindingUsers).toEqual(['apps/web/src/lib/media/worker-media.ts'])
    const publicUrl = readFileSync(resolve('apps/web/src/db/public-url.ts'), 'utf8')
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

    const authDirectory = resolve(project.sourceDirectory, 'lib/auth')
    for (const file of readdirSync(authDirectory).filter(name => !name.includes('.test.'))) {
      const source = readFileSync(resolve(authDirectory, file), 'utf8')
      expect(source, file).not.toMatch(/\b(?:SELECT|INSERT|UPDATE|DELETE)\b|\.prepare\(|\.batch\(/u)
    }
    const server = readFileSync(resolve(authDirectory, 'server.ts'), 'utf8')
    expect(server).toContain("import 'server-only'")
    expect(server).toContain('getCloudflareContext')
    expect(server).toContain('createDatabase(binding)')
    const operations = readFileSync(resolve('apps/web/src/db/auth.ts'), 'utf8')
    expect(operations).not.toMatch(/getCloudflareContext|process\.env/u)
  })

  it('makes every admin page and admin API route require an admin', () => {
    const adminRoutes = trackedFiles().filter(
      file =>
        (file.startsWith(`${project.sourceDirectory}/app/(dashboard)/admin/`) ||
          file.startsWith(`${project.sourceDirectory}/app/api/admin/`)) &&
        /(?:^|\/)(?:page|route|layout)\.tsx?$/u.test(file) &&
        existsSync(resolve(file))
    )
    expect(adminRoutes).toEqual(
      expect.arrayContaining([
        `${project.sourceDirectory}/app/(dashboard)/admin/layout.tsx`,
        `${project.sourceDirectory}/app/(dashboard)/admin/page.tsx`,
        `${project.sourceDirectory}/app/(dashboard)/admin/[...path]/page.tsx`,
        `${project.sourceDirectory}/app/api/admin/[[...path]]/route.ts`
      ])
    )
    for (const file of adminRoutes) {
      const source = readFileSync(resolve(file), 'utf8')
      expect(source, `${file} must call requireAdmin() or authorizeAdminRequest()`).toMatch(
        /await (?:requireAdmin|authorizeAdminRequest)\(/u
      )
    }
  })

  // The submitter dashboard (#65): every page and write is scoped to the signed-in user, and its
  // SQL (owner scoping included) lives in the shared data package.
  it('makes every account page and account API route require the signed-in user (#65)', () => {
    const accountRoutes = trackedFiles().filter(
      file =>
        (file.startsWith(`${project.sourceDirectory}/app/(dashboard)/account/`) ||
          file.startsWith(`${project.sourceDirectory}/app/api/account/`)) &&
        /(?:^|\/)(?:page|route)\.tsx?$/u.test(file) &&
        existsSync(resolve(file))
    )
    expect(accountRoutes).toEqual(
      expect.arrayContaining([
        `${project.sourceDirectory}/app/(dashboard)/account/page.tsx`,
        `${project.sourceDirectory}/app/(dashboard)/account/submissions/[id]/page.tsx`,
        `${project.sourceDirectory}/app/(dashboard)/account/listings/[slug]/edit/page.tsx`,
        `${project.sourceDirectory}/app/api/account/submissions/[id]/[action]/route.ts`,
        `${project.sourceDirectory}/app/api/account/listings/[id]/[action]/route.ts`
      ])
    )
    for (const file of accountRoutes) {
      const source = readFileSync(resolve(file), 'utf8')
      expect(source, `${file} must call requireAccountUser() or authorizeUserRequest()`).toMatch(
        file.includes('/app/api/') ? /await authorizeUserRequest\(/u : /await requireAccountUser\(/u
      )
    }
    const accountDirectory = resolve(project.sourceDirectory, 'lib/account')
    for (const file of readdirSync(accountDirectory).filter(name => !name.includes('.test.'))) {
      const source = readFileSync(resolve(accountDirectory, file), 'utf8')
      expect(source, file).not.toMatch(/\b(?:SELECT|INSERT|UPDATE|DELETE)\b|\.prepare\(|\.batch\(/u)
    }
    const runtime = readFileSync(resolve(accountDirectory, 'runtime.ts'), 'utf8')
    expect(runtime).toContain("import 'server-only'")
    expect(runtime).toContain('createDatabase(workerEnv.DB)')
    const operations = readFileSync(resolve('apps/web/src/db/account.ts'), 'utf8')
    expect(operations).not.toMatch(/getCloudflareContext|process\.env/u)
  })

  it('keeps admin panel SQL in the shared data package (#64)', () => {
    const adminDirectory = resolve(project.sourceDirectory, 'lib/admin')
    for (const file of readdirSync(adminDirectory).filter(name => !name.includes('.test.'))) {
      const source = readFileSync(resolve(adminDirectory, file), 'utf8')
      expect(source, file).not.toMatch(/\b(?:SELECT|INSERT|UPDATE|DELETE)\b|\.prepare\(|\.batch\(/u)
    }
    const runtime = readFileSync(resolve(adminDirectory, 'runtime.ts'), 'utf8')
    expect(runtime).toContain("import 'server-only'")
    expect(runtime).toContain('createDatabase(workerEnv.DB)')
    const requests = readFileSync(resolve(adminDirectory, 'requests.ts'), 'utf8')
    expect(requests).toContain("import 'server-only'")
  })

  // Billing (#68): the ledger's SQL lives in the shared data package, and everything specific to
  // the payment provider stays behind the billing module's interface, so Lago can replace Stripe.
  it('keeps billing SQL in the data package and the provider inside the billing module (#68)', () => {
    const billingDirectory = resolve(project.sourceDirectory, 'lib/billing')
    const billingFiles = [
      ...readdirSync(billingDirectory).filter(name => name.endsWith('.ts')),
      ...readdirSync(resolve(billingDirectory, 'providers')).map(name => `providers/${name}`)
    ].filter(name => !name.includes('.test.'))
    for (const file of billingFiles) {
      const source = readFileSync(resolve(billingDirectory, file), 'utf8')
      expect(source, file).not.toMatch(/\b(?:SELECT|INSERT|UPDATE|DELETE)\b|\.prepare\(|\.batch\(/u)
    }
    const runtime = readFileSync(resolve(billingDirectory, 'runtime.ts'), 'utf8')
    expect(runtime).toContain("import 'server-only'")
    const providerSpecific =
      /api\.stripe\.com|createStripeProvider|stripe-signature|checkout\.session/iu
    const outside = trackedFiles().filter(
      file =>
        /\.(?:ts|tsx)$/u.test(file) &&
        file.startsWith(`${project.appDirectory}/`) &&
        // The E2E suite's Stripe mock (e2e/billing-fixture.ts) speaks the provider's API and
        // holds its test secrets; both checks cover the app's own code.
        !file.startsWith(`${project.appDirectory}/e2e/`) &&
        !file.startsWith(`${project.sourceDirectory}/lib/billing/providers/`) &&
        existsSync(resolve(file)) &&
        providerSpecific.test(readFileSync(resolve(file), 'utf8'))
    )
    expect(outside).toEqual([])
    // Only the configured provider (`lib/billing/providers/`) reads the provider's secrets.
    const secretReaders = trackedFiles().filter(
      file =>
        /\.(?:ts|tsx)$/u.test(file) &&
        file.startsWith(`${project.appDirectory}/`) &&
        !file.startsWith(`${project.appDirectory}/e2e/`) &&
        !file.endsWith('.d.ts') &&
        !file.startsWith(`${project.sourceDirectory}/lib/billing/providers/`) &&
        existsSync(resolve(file)) &&
        /STRIPE_(?:SECRET_KEY|WEBHOOK_SECRET)/u.test(readFileSync(resolve(file), 'utf8'))
    )
    expect(secretReaders).toEqual([])
  })

  // Owner decision on #70 (#68): the payment provider changes soon, so its name is never shown to
  // submitters or admins: not on pages, in emails, in the admin panel, in error lines, in the
  // legal pages, or in the item names sent to the provider's own page. Only the provider's
  // implementation (`lib/billing/providers/`), config and env names, and developer docs name it.
  it("never shows the payment provider's name to people (#68, owner decision on #70)", () => {
    const named = /stripe/iu
    const textOf = (file: string, sourceText: string): Array<{ line: number; text: string }> => {
      const source = ts.createSourceFile(
        file,
        sourceText,
        ts.ScriptTarget.Latest,
        true,
        file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
      )
      const texts: Array<{ line: number; text: string }> = []
      const visit = (node: ts.Node): void => {
        if (
          ts.isStringLiteral(node) ||
          ts.isNoSubstitutionTemplateLiteral(node) ||
          ts.isTemplateHead(node) ||
          ts.isTemplateMiddle(node) ||
          ts.isTemplateTail(node) ||
          ts.isJsxText(node)
        ) {
          texts.push({
            line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
            text: node.text
          })
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
      return texts
    }
    // The check sees the name in a string, a template, and JSX text.
    expect(
      textOf(
        'probe.tsx',
        'const a = "Pay with Stripe"; const b = `$' + '{a} STRIPE`; <p>stripe</p>'
      )
        .filter(({ text }) => named.test(text))
        .map(({ text }) => text.trim())
    ).toEqual(['Pay with Stripe', 'STRIPE', 'stripe'])
    const userFacing = trackedFiles().filter(
      file =>
        /\.(?:ts|tsx)$/u.test(file) &&
        !/\.(?:test|spec)\.tsx?$/u.test(file) &&
        !file.endsWith('.d.ts') &&
        (['app/', 'components/', 'lib/', 'hooks/'].some(dir =>
          file.startsWith(`${project.sourceDirectory}/${dir}`)
        ) ||
          [
            'apps/web/src/lib/site/',
            // Validation and error messages the data layer returns to pages (#111 round 4).
            'apps/web/src/db/'
          ].some(dir => file.startsWith(dir))) &&
        !file.startsWith(`${project.sourceDirectory}/lib/billing/providers/`) &&
        existsSync(resolve(file))
    )
    expect(userFacing.length).toBeGreaterThan(100)
    // Every string, template, and JSX text the code could put in front of someone, emails
    // included (their templates are code in `lib/email/`).
    const shown = userFacing.flatMap(file =>
      textOf(file, readFileSync(resolve(file), 'utf8'))
        .filter(({ text }) => named.test(text))
        .map(({ line, text }) => `${file}:${line}: ${text.trim().slice(0, 80)}`)
    )
    // The provider's own folder names it in code, but what it shows on the provider's page comes
    // only from the order's neutral description (#111 round 4), checked above where it is built.
    const provider = readFileSync(
      resolve(project.sourceDirectory, 'lib/billing/providers/stripe.ts'),
      'utf8'
    )
    expect(provider).toMatch(
      /'line_items\[0\]\[price_data\]\[product_data\]\[name\]': request\.description,/u
    )
    expect(provider).not.toMatch(/product_data\]\[(?!name\])/u)
    expect(provider).not.toMatch(/custom_text|submit_type|statement_descriptor/u)
    // The legal pages and the site's other written content.
    for (const file of trackedFiles().filter(
      name => name.startsWith('apps/web/content/') && existsSync(resolve(name))
    )) {
      if (named.test(readFileSync(resolve(file), 'utf8'))) shown.push(file)
    }
    expect(shown).toEqual([])
  })

  it('keeps claim SQL in the shared data package (#67)', () => {
    const claimsDirectory = resolve(project.sourceDirectory, 'lib/claims')
    for (const file of readdirSync(claimsDirectory).filter(name => !name.includes('.test.'))) {
      const source = readFileSync(resolve(claimsDirectory, file), 'utf8')
      expect(source, file).not.toMatch(/\b(?:SELECT|INSERT|UPDATE|DELETE)\b|\.prepare\(|\.batch\(/u)
    }
    const runtime = readFileSync(resolve(claimsDirectory, 'runtime.ts'), 'utf8')
    expect(runtime).toContain("import 'server-only'")
  })

  it('catches every way code can write badge checks (#66 review round 1)', () => {
    for (const write of [
      'INSERT INTO badge_checks (listing_id) VALUES (?)',
      'insert into "badge_checks" (listing_id) values (?)',
      'INSERT OR REPLACE INTO `badge_checks` VALUES (?)',
      "UPDATE 'badge_checks' SET reason = ?",
      'DELETE FROM [badge_checks] WHERE id = ?',
      'REPLACE INTO badge_checks VALUES (?)',
      'db.insert(badgeChecks).values(row)',
      'db.update( badgeChecks ).set(row)',
      'db.delete(schema.badgeChecks)'
    ]) {
      expect(writesBadgeChecks(write), write).toBe(true)
    }
    for (const read of [
      'SELECT outcome FROM badge_checks',
      'db.select().from(badgeChecks)',
      'badge_checks_listing_time_idx'
    ]) {
      expect(writesBadgeChecks(read), read).toBe(false)
    }
  })

  it('lets only the badge program write badge checks, through the shared data package (#66)', () => {
    // `badge_checks` is the weekly program's history. An owner's "Verify badge" or "Re-verify
    // now" (#63, #65) records its result on the submission, never here, so a manual check can
    // neither open nor end a warning.
    const writers = trackedFiles().filter(
      file =>
        /\.(?:ts|tsx)$/u.test(file) &&
        !/\.test\.tsx?$/u.test(file) &&
        !file.startsWith('apps/web/src/db/test-support') &&
        !file.startsWith('apps/web/e2e/') &&
        writesBadgeChecks(readFileSync(resolve(file), 'utf8'))
    )
    expect(writers).toEqual(['apps/web/src/db/badge-program.ts'])
    const programDirectory = resolve(project.sourceDirectory, 'lib/badge-program')
    for (const file of readdirSync(programDirectory).filter(name => !name.includes('.test.'))) {
      const source = readFileSync(resolve(programDirectory, file), 'utf8')
      expect(source, file).not.toMatch(/\b(?:SELECT|INSERT|UPDATE|DELETE)\b|\.prepare\(|\.batch\(/u)
    }
  })

  // A Server Action is reachable by its action id from any page path, so no path-based gate
  // (the Worker's /admin lock included) ever sees it, and each action must authorize itself.
  // The admin panel (#64) decided: admin writes are route handlers under /api/admin, which the
  // Worker gate and `authorizeAdminRequest()` (session, allowlist, trusted Origin) both see. No
  // module the app bundles may declare a Server Action.
  it('keeps Server Actions out of the app: admin writes are /api/admin route handlers (#64)', () => {
    const violations = trackedFiles().filter(file => {
      if (
        !file.startsWith(`${project.appDirectory}/`) ||
        !/\.(?:m?[jt]sx?)$/u.test(file) ||
        !existsSync(resolve(file))
      )
        return false
      return /^\s*['"]use server['"]/mu.test(readFileSync(resolve(file), 'utf8'))
    })
    expect(violations).toEqual([])
  })

  it('keeps one fresh Drizzle migration history and forbids push-based schema mutation', () => {
    const config = readFileSync(resolve('apps/web/drizzle.config.ts'), 'utf8')
    expect(config).toContain("out: './drizzle'")
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

  // #77: node:sqlite applies none of D1's statement limits and workerd does not enforce the
  // 32-argument function limit, so these are checked on the SQL text itself.
  it('keeps user input out of LIKE/GLOB patterns and every SQL function within 32 arguments', () => {
    const sqlSources = trackedFiles().filter(
      file =>
        (file.startsWith('apps/web/src/db/') || /^scripts\/[^/]+\.ts$/u.test(file)) &&
        file.endsWith('.ts') &&
        !file.endsWith('.test.ts') &&
        existsSync(resolve(file))
    )
    const violations = sqlSources.flatMap(file =>
      sqlSourceViolations(file, readFileSync(resolve(file), 'utf8'))
    )
    for (const migration of readdirSync(resolve('apps/web/drizzle')).filter(name =>
      name.endsWith('.sql')
    )) {
      const statements = readFileSync(resolve('apps/web/drizzle', migration), 'utf8').split(
        '--> statement-breakpoint'
      )
      for (const statement of statements) {
        for (const violation of d1StatementLimitViolations(statement)) {
          violations.push(`apps/web/drizzle/${migration}: ${violation}`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  // #81 review: the first version of the check missed each of these.
  it('catches every way a bound value can reach a LIKE/GLOB pattern', () => {
    const bypasses: Record<string, string> = {
      'Drizzle like() helper': `import { like } from 'drizzle-orm'
        export const f = (q: string) => like(listings.name, \`%\${q}%\`)`,
      'Drizzle namespace ilike()': `import * as orm from 'drizzle-orm'
        export const f = (q: string) => orm.ilike(listings.name, q)`,
      'sql fragment without a statement keyword': `import { sql } from 'drizzle-orm'
        export const f = (q: string) => sql\`\${listings.name} LIKE \${\`%\${q}%\`}\``,
      'lowercase statement': `export const f = 'select id from listings where name like ?'`,
      'concatenated pattern in parentheses': `export const f = \`SELECT id FROM listings WHERE name LIKE ('%' || ? || '%')\``,
      'function form': `export const f = 'SELECT id FROM listings WHERE like(?, name)'`,
      'wrapped pattern': `export const f = 'SELECT id FROM t WHERE name NOT GLOB lower(?) AND x = 1'`,
      'literal function-form pattern over 50 bytes': `export const f = "SELECT like('${'%'.repeat(60)}', name)"`,
      'function with 33 arguments': `export const f = 'SELECT max(${Array(33).fill('1').join(',')})'`
    }
    for (const [name, source] of Object.entries(bypasses)) {
      expect(sqlSourceViolations(`fixture.ts`, source), name).not.toEqual([])
    }
    for (const safe of [
      `export const f = "SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND type = ?"`,
      `export const f = 'SELECT id FROM t WHERE instr(lower(name), ?) > 0 AND slug LIKE \\'a%\\''`,
      `import { eq, sql } from 'drizzle-orm'
        export const f = (q: string) => sql\`\${listings.name} = \${q}\``,
      `export const message = 'Looks like a good choice.'`
    ]) {
      expect(sqlSourceViolations('fixture.ts', safe), safe).toEqual([])
    }
  })

  it('keeps retired public static repositories out of live application links', () => {
    const siteConfig = readFileSync(resolve('apps/web/src/lib/site/site.ts'), 'utf8')
    const cookiePolicy = readFileSync(resolve('apps/web/content/legal/cookies.mdx'), 'utf8')

    expect(siteConfig).toContain('githubIssueOwner: null')
    expect(siteConfig).toContain('githubIssueRepo: null')
    expect(siteConfig).toContain('githubIssuesUrl: null')
    expect(siteConfig).not.toMatch(
      /github\.com\/serpcompany\/(?:serp\.software|pornvideodownloaders)/u
    )
    expect(cookiePolicy).not.toContain('github.com/serpcompany/serp.software')
  })
})

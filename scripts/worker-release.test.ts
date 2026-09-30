import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import {
  assertSchemaCompatible,
  parseDatabaseGeneration,
  requiredMigrationNames,
  runWorkerRelease,
  validateWorkerConfig,
  type WorkerReleaseDependencies
} from './worker-release.ts'

const sha = 'a'.repeat(40)
const productionEnv = {
  CI: 'true',
  GITHUB_ACTIONS: 'true',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_SHA: sha,
  GITHUB_WORKFLOW_REF:
    'serpcompany/directory-platform-d1/.github/workflows/build-and-deploy.yml@refs/heads/main',
  WORKER_PRODUCTION_CONFIRM: 'deploy-serp.software-production',
  CLOUDFLARE_D1_PRODUCTION_DATABASE_ID: 'test-production-id',
  CLOUDFLARE_D1_PRODUCTION_DATABASE_NAME: 'test-production-name',
  CLOUDFLARE_WORKER_PRODUCTION_NAME: 'test-production-worker'
}

function dependencies(
  outputs: Array<{ status: number; stderr?: string; stdout?: string }> = []
): WorkerReleaseDependencies & { run: ReturnType<typeof vi.fn> } {
  return {
    readFile: () => Buffer.from('backup'),
    run: vi.fn(() => outputs.shift() ?? { status: 0 })
  }
}

describe('Worker release guard', () => {
  it('parses database generation strictly and requires it in replatform execution', () => {
    expect(parseDatabaseGeneration(undefined, { requireExplicit: false })).toBe('legacy')
    expect(parseDatabaseGeneration('legacy', { requireExplicit: true })).toBe('legacy')
    expect(parseDatabaseGeneration('replatform', { requireExplicit: true })).toBe('replatform')
    expect(() => parseDatabaseGeneration(undefined, { requireExplicit: true })).toThrow(
      'must explicitly equal'
    )
    expect(() => parseDatabaseGeneration('replatfrom', { requireExplicit: false })).toThrow(
      'must explicitly equal'
    )
  })
  it('validates isolated checked-in placeholder configs', () => {
    expect(() => validateWorkerConfig('preview', 'serp.software')).not.toThrow()
    expect(() => validateWorkerConfig('production', 'serp.software')).not.toThrow()
    expect(() => validateWorkerConfig('preview', 'pornvideodownloaders.com')).not.toThrow()
    expect(() => validateWorkerConfig('production', 'pornvideodownloaders.com')).not.toThrow()
    expect(readFileSync('configs/wrangler/serp.software/preview.jsonc', 'utf8')).not.toContain(
      'PRODUCTION'
    )
    expect(readFileSync('configs/wrangler/serp.software/production.jsonc', 'utf8')).not.toContain(
      'PREVIEW'
    )
    expect(
      readFileSync('configs/wrangler/pornvideodownloaders.com/preview.jsonc', 'utf8')
    ).not.toContain('serp.software')
  })

  it('uses a workerd-compatible Markdown renderer in both Workers', () => {
    for (const siteId of ['serp.software', 'pornvideodownloaders.com']) {
      const config = readFileSync(`apps/${siteId}/next.config.ts`, 'utf8')
      const packageJson = readFileSync(`apps/${siteId}/package.json`, 'utf8')
      expect(config).not.toContain('next-mdx-remote')
      expect(packageJson).not.toContain('next-mdx-remote')
    }
    expect(readFileSync('packages/web-core/package.json', 'utf8')).not.toContain('next-mdx-remote')
    expect(readFileSync('packages/web-core/src/static-pages/legal-page.tsx', 'utf8')).toContain(
      'ReactMarkdown'
    )
  })

  it('requires explicit confirmation for credential-free remote plans', () => {
    expect(() =>
      runWorkerRelease(['plan-migration', 'production', '--site', 'serp.software'], {})
    ).toThrow('D1_REMOTE_CONFIRM')
    expect(() =>
      runWorkerRelease(['plan-verify', 'preview', '--site', 'pornvideodownloaders.com'], {})
    ).toThrow('D1_REMOTE_CONFIRM')
    expect(() => runWorkerRelease(['validate', 'preview'], {})).toThrow('explicit --site')
  })

  it('plans routine replacement releases from the Drizzle migration lineage only', () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      runWorkerRelease(['plan-migration', 'production', '--site', 'serp.software'], {
        D1_REMOTE_CONFIRM: 'plan-serp.software-production',
        D1_RELEASE_GENERATION: 'replatform'
      })
      const plan = JSON.parse(String(output.mock.calls.at(-1)?.[0])) as {
        generation: string
        migrations: string[]
      }
      expect(plan.generation).toBe('replatform')
      expect(plan.migrations).toEqual(['0000_remarkable_manta.sql'])
      expect(plan.migrations).not.toContain('0001_initial_schema.sql')
    } finally {
      output.mockRestore()
    }
  })

  it('treats repository migrations as minimum schema and permits forward schema rows', () => {
    const required = requiredMigrationNames()
    expect(required).toEqual([
      '0001_public_catalog.sql',
      '0002_listing_slug_redirects.sql',
      '0003_publication_run_provenance.sql',
      '0004_listing_display_order.sql',
      '0005_listing_submissions.sql',
      '0006_submission_rate_limits.sql',
      '0007_submission_notifications.sql',
      '0008_submission_review_preview.sql',
      '0009_related_listing_name_index.sql'
    ])
    expect(() =>
      assertSchemaCompatible(required, [
        ...required.map(name => ({ name })),
        { name: '0010_forward_compatible.sql' }
      ])
    ).not.toThrow()
    expect(() =>
      assertSchemaCompatible(
        required,
        required.slice(0, -1).map(name => ({ name }))
      )
    ).toThrow('0009_related_listing_name_index.sql')
    expect(() =>
      assertSchemaCompatible(required, [{ name: required[0] }, { name: required[0] }])
    ).toThrow('duplicated')
    expect(() => assertSchemaCompatible(required, [{ unexpected: 'shape' }])).toThrow('malformed')
    expect(() => assertSchemaCompatible(required, [])).toThrow('empty')
  })

  it('rejects a non-main ref, missing confirmation, and dirty simulated CI checkout', () => {
    expect(() =>
      runWorkerRelease(
        ['deploy', 'production', '--site', 'serp.software'],
        { ...productionEnv, GITHUB_REF: 'refs/heads/topic' },
        dependencies()
      )
    ).toThrow('main branch')
    expect(() =>
      runWorkerRelease(
        ['deploy', 'production', '--site', 'serp.software'],
        { ...productionEnv, WORKER_PRODUCTION_CONFIRM: '' },
        dependencies()
      )
    ).toThrow('confirmation')
    expect(() =>
      runWorkerRelease(
        ['deploy', 'production', '--site', 'serp.software'],
        productionEnv,
        dependencies([{ status: 0, stdout: ' M package.json' }])
      )
    ).toThrow('clean source checkout')
  })

  it('rejects a checkout whose HEAD does not match GITHUB_SHA', () => {
    const process = dependencies([
      { status: 0, stdout: '' },
      { status: 0, stdout: 'b'.repeat(40) }
    ])
    expect(() =>
      runWorkerRelease(['deploy', 'production', '--site', 'serp.software'], productionEnv, process)
    ).toThrow('HEAD must match')
  })

  it('builds guarded remote backup, migration, verification, and OpenNext commands without executing them', () => {
    const commands = ['backup', 'check-schema', 'migrate', 'verify', 'deploy'] as const
    for (const command of commands) {
      const outputs = [
        { status: 0, stdout: '' },
        { status: 0, stdout: sha }
      ]
      if (command === 'check-schema') {
        outputs.push({
          status: 0,
          stdout: JSON.stringify([
            {
              meta: { duration: 0.1, rows_read: 9, rows_written: 0 },
              results: requiredMigrationNames().map(name => ({ name })),
              success: true
            }
          ])
        })
      } else if (command === 'verify') {
        const report = parse(readFileSync('d1/artifacts/serp-software-v1-parity.yaml', 'utf8')) as {
          parity: {
            categories: Array<{ slug: string }>
            categoryMembershipCount: number
            exactSlugSet: string[]
            featuredSlugs: string[]
          }
          target: { categoryCount: number; checksum: string; listingCount: number }
        }
        outputs.push({
          status: 0,
          stdout: JSON.stringify([
            {
              success: true,
              results: [
                {
                  categories: report.parity.categories.map(category => category.slug).join('\0'),
                  category_count: report.target.categoryCount,
                  checksum: report.target.checksum,
                  featured_count: report.parity.featuredSlugs.length,
                  listing_count: report.target.listingCount,
                  membership_count: report.parity.categoryMembershipCount,
                  slugs: report.parity.exactSlugSet.join('\0'),
                  version: 1
                }
              ]
            }
          ])
        })
      } else if (command === 'migrate') {
        outputs.push({ status: 0, stdout: '[{"success":true,"results":[]}]' })
        outputs.push({ status: 0, stdout: '' })
      } else outputs.push({ status: 0, stdout: '' })
      const process = dependencies(outputs)
      expect(() =>
        runWorkerRelease([command, 'production', '--site', 'serp.software'], productionEnv, process)
      ).not.toThrow()
      const invocation = process.run.mock.calls[command === 'migrate' ? 3 : 2]
      expect(invocation?.[0]).toBe('pnpm')
      expect(invocation?.[1]).toContain(
        resolve('.wrangler/generated/serp-software.production.jsonc')
      )
      const generated = JSON.parse(
        readFileSync(resolve('.wrangler/generated/serp-software.production.jsonc'), 'utf8')
      ) as {
        $schema?: string
        assets?: { directory?: string }
        d1_databases?: Array<{ binding?: string; migrations_dir?: string }>
        main?: string
      }
      expect(generated.$schema).toBe('../../node_modules/wrangler/config-schema.json')
      expect(generated.main).toBe('../../apps/serp.software/.open-next/worker.js')
      expect(generated.assets?.directory).toBe('../../apps/serp.software/.open-next/assets')
      expect(
        generated.d1_databases?.find(binding => binding.binding === 'DB')?.migrations_dir
      ).toBe('../../d1/migrations')
      if (command === 'deploy') expect(invocation?.[1]).toContain('opennextjs-cloudflare')
      else {
        expect(invocation?.[1]).toContain('wrangler')
        expect(invocation?.[1]).toContain('--remote')
      }
    }
  })

  it('fails closed on unsuccessful, malformed, or unparseable Wrangler JSON envelopes', () => {
    const envelopes = [
      JSON.stringify([{ errors: [{ message: 'denied' }], success: false }]),
      JSON.stringify([{ results: [], success: false }]),
      JSON.stringify({ results: [], success: true }),
      JSON.stringify([{ success: true }]),
      'not-json'
    ]

    for (const stdout of envelopes) {
      const process = dependencies([
        { status: 0, stdout: '' },
        { status: 0, stdout: sha },
        { status: 0, stdout }
      ])
      expect(() =>
        runWorkerRelease(
          ['check-schema', 'production', '--site', 'serp.software'],
          productionEnv,
          process
        )
      ).toThrow('Do not deploy Worker-only')
      expect(process.run.mock.calls.some(call => call[1].includes('opennextjs-cloudflare'))).toBe(
        false
      )
    }
  })

  it('does not reflect remote command output, bindings, or credentials in schema failures', () => {
    const sensitiveMarker = 'sensitive-test-marker'
    const process = dependencies([
      { status: 0, stdout: '' },
      { status: 0, stdout: sha },
      { status: 1, stderr: sensitiveMarker }
    ])

    let message = ''
    try {
      runWorkerRelease(
        ['check-schema', 'production', '--site', 'serp.software'],
        { ...productionEnv, CLOUDFLARE_API_TOKEN: sensitiveMarker },
        process
      )
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('Do not deploy Worker-only')
    expect(message).not.toContain(sensitiveMarker)
    expect(message).not.toContain('test-production-id')
    expect(message).not.toContain('test-production-name')
    expect(message).not.toContain('test-production-worker')
    expect(process.run.mock.calls.some(call => call[1].includes('opennextjs-cloudflare'))).toBe(
      false
    )
  })

  it('imports the deterministic catalog only into an empty production publication', () => {
    const process = dependencies([
      { status: 0, stdout: '' },
      { status: 0, stdout: sha },
      { status: 0, stdout: '[{"success":true,"results":[]}]' },
      {
        status: 0,
        stdout: '[{"success":true,"results":[{"checksum":null,"site_exists":0}]}]'
      }
    ])
    expect(() =>
      runWorkerRelease(['import', 'production', '--site', 'serp.software'], productionEnv, process)
    ).not.toThrow()
    const remoteCalls = process.run.mock.calls.slice(4)
    expect(remoteCalls.length).toBeGreaterThan(1)
    expect(remoteCalls.every(call => call[1].includes('--remote'))).toBe(true)
    expect(remoteCalls.some(call => call[1].includes('--file'))).toBe(true)
  })

  it('refuses to replay an interrupted initial import over partial site rows', () => {
    const process = dependencies([
      { status: 0, stdout: '' },
      { status: 0, stdout: sha },
      { status: 0, stdout: '[{"success":true,"results":[]}]' },
      {
        status: 0,
        stdout: '[{"success":true,"results":[{"checksum":null,"site_exists":1}]}]'
      }
    ])
    expect(() =>
      runWorkerRelease(['import', 'production', '--site', 'serp.software'], productionEnv, process)
    ).toThrow('restore the pre-import backup')
    expect(process.run.mock.calls.some(call => call[1].includes('--file'))).toBe(false)
  })

  it('refuses generic Production migration and import while the cutover lock is active', () => {
    for (const command of ['migrate', 'import'] as const) {
      const process = dependencies([
        { status: 0, stdout: '' },
        { status: 0, stdout: sha },
        {
          status: 0,
          stdout: '[{"success":true,"results":[{"id":"d1-cutover-lock-v1:serp.software:run-1"}]}]'
        }
      ])
      expect(() =>
        runWorkerRelease([command, 'production', '--site', 'serp.software'], productionEnv, process)
      ).toThrow(/cutover is frozen/u)
      expect(process.run).toHaveBeenCalledTimes(3)
      expect(process.run.mock.calls[2]?.[1].join(' ')).toContain('migration_runs')
      expect(process.run.mock.calls.some(call => call[1].includes('--file'))).toBe(false)
      expect(process.run.mock.calls.some(call => call[1].includes('apply'))).toBe(false)
    }
  })

  it('binds preview release authority and commands to pornvideodownloaders.com', () => {
    const previewEnv = {
      ...productionEnv,
      GITHUB_WORKFLOW_REF:
        'serpcompany/directory-platform-d1/.github/workflows/deploy-pornvideodownloaders.yml@refs/heads/main',
      WORKER_PRODUCTION_CONFIRM: 'deploy-pornvideodownloaders.com-preview',
      CLOUDFLARE_D1_PREVIEW_DATABASE_ID: 'pvd-preview-id',
      CLOUDFLARE_D1_PREVIEW_DATABASE_NAME: 'pvd-preview-db',
      CLOUDFLARE_WORKER_PREVIEW_NAME: 'pvd-preview-worker'
    }
    const process = dependencies([
      { status: 0, stdout: '' },
      { status: 0, stdout: sha },
      { status: 0, stdout: '' }
    ])
    expect(() =>
      runWorkerRelease(
        ['deploy', 'preview', '--site', 'pornvideodownloaders.com'],
        previewEnv,
        process
      )
    ).not.toThrow()
    const invocation = process.run.mock.calls[2]
    expect(invocation?.[1]).toContain('pornvideodownloaders.com')
    expect(invocation?.[1]).toContain(
      resolve('.wrangler/generated/pornvideodownloaders-com.preview.jsonc')
    )
  })

  it('materializes the fresh-history replacement config only in the protected Preview rehearsal', () => {
    const previewEnv = {
      ...productionEnv,
      GITHUB_WORKFLOW_REF:
        'serpcompany/directory-platform-d1/.github/workflows/rehearse-d1-replatform-preview.yml@refs/heads/main',
      GITHUB_REF: 'refs/heads/main',
      WORKER_PRODUCTION_CONFIRM: 'rehearse-serp.software-preview',
      D1_RELEASE_GENERATION: 'replatform',
      CLOUDFLARE_D1_REPLACEMENT_PREVIEW_DATABASE_ID: 'replacement-preview-id',
      CLOUDFLARE_D1_REPLACEMENT_PREVIEW_DATABASE_NAME: 'replacement-preview-name',
      CLOUDFLARE_WORKER_PREVIEW_NAME: 'serp-preview-worker'
    }
    const process = dependencies([
      { status: 0, stdout: '' },
      { status: 0, stdout: sha },
      { status: 0, stdout: '' }
    ])
    expect(() =>
      runWorkerRelease(['migrate', 'preview', '--site', 'serp.software'], previewEnv, process)
    ).not.toThrow()
    const generatedPath = resolve('.wrangler/generated/serp-software.preview.replatform.jsonc')
    const generated = JSON.parse(readFileSync(generatedPath, 'utf8')) as {
      d1_databases: Array<{ database_id: string; migrations_dir: string }>
    }
    expect(generated.d1_databases[0]).toEqual(
      expect.objectContaining({
        database_id: 'replacement-preview-id',
        migrations_dir: '../../d1/drizzle'
      })
    )
    expect(process.run.mock.calls[2]?.[1]).toEqual(
      expect.arrayContaining(['migrations', 'apply', 'replacement-preview-name', '--remote'])
    )
  })

  it('applies fresh Production history only through the exact protected cutover workflow', () => {
    const cutoverEnv = {
      ...productionEnv,
      GITHUB_WORKFLOW_REF:
        'serpcompany/directory-platform-d1/.github/workflows/cutover-d1-replatform-production.yml@refs/heads/main',
      WORKER_PRODUCTION_CONFIRM: 'cutover-serp.software-production',
      D1_RELEASE_GENERATION: 'replatform',
      CLOUDFLARE_D1_REPLACEMENT_PRODUCTION_DATABASE_ID: 'replacement-production-id',
      CLOUDFLARE_D1_REPLACEMENT_PRODUCTION_DATABASE_NAME: 'replacement-production-name'
    }
    const process = dependencies([
      { status: 0, stdout: '' },
      { status: 0, stdout: sha },
      { status: 0, stdout: '' },
      { status: 0, stdout: sha },
      { status: 0, stdout: '' }
    ])
    expect(() =>
      runWorkerRelease(
        ['cutover-migrate', 'production', '--site', 'serp.software'],
        cutoverEnv,
        process
      )
    ).not.toThrow()
    expect(process.run.mock.calls.at(-1)?.[1]).toEqual(
      expect.arrayContaining(['migrations', 'apply', 'replacement-production-name', '--remote'])
    )
    for (const changed of [
      { GITHUB_REF: 'refs/heads/topic' },
      { GITHUB_WORKFLOW_REF: productionEnv.GITHUB_WORKFLOW_REF },
      { D1_RELEASE_GENERATION: 'legacy' },
      { WORKER_PRODUCTION_CONFIRM: 'deploy-serp.software-production' }
    ])
      expect(() =>
        runWorkerRelease(
          ['cutover-migrate', 'production', '--site', 'serp.software'],
          { ...cutoverEnv, ...changed },
          dependencies()
        )
      ).toThrow('exact protected main workflow')
  })

  it('rejects arbitrary branches, tags, PR refs, and Production from the Preview rehearsal workflow', () => {
    const base = {
      ...productionEnv,
      WORKER_PRODUCTION_CONFIRM: 'rehearse-serp.software-preview',
      D1_RELEASE_GENERATION: 'replatform',
      CLOUDFLARE_D1_REPLACEMENT_PREVIEW_DATABASE_ID: 'replacement-preview-id',
      CLOUDFLARE_D1_REPLACEMENT_PREVIEW_DATABASE_NAME: 'replacement-preview-name',
      CLOUDFLARE_WORKER_PREVIEW_NAME: 'serp-preview-worker'
    }
    for (const ref of ['refs/heads/codex/other-branch', 'refs/tags/preview', 'refs/pull/72/merge'])
      expect(() =>
        runWorkerRelease(
          ['migrate', 'preview', '--site', 'serp.software'],
          {
            ...base,
            GITHUB_REF: ref,
            GITHUB_WORKFLOW_REF: `owner/repo/.github/workflows/rehearse-d1-replatform-preview.yml@${ref}`
          },
          dependencies()
        )
      ).toThrow('exact checked-in integration ref')
    expect(() =>
      runWorkerRelease(
        ['migrate', 'production', '--site', 'serp.software'],
        {
          ...base,
          GITHUB_REF: 'refs/heads/main',
          GITHUB_WORKFLOW_REF:
            'owner/repo/.github/workflows/rehearse-d1-replatform-preview.yml@refs/heads/main'
        },
        dependencies()
      )
    ).toThrow('exact checked-in integration ref')
  })
})

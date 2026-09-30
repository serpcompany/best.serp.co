import { readFileSync } from 'node:fs'
import { resolveRuntimeSiteId } from '@serpdirectory/site-contract/active-site-ids'
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { resolveSiteTarget, siteIds, siteTargets } from './site-targets'

interface Step {
  'continue-on-error'?: boolean
  env?: Record<string, string>
  if?: string
  name?: string
  run?: string
  uses?: string
  with?: Record<string, string>
}

interface Job {
  environment: { name: string }
  if: string
  steps: Step[]
}

interface Workflow {
  jobs: { preview: Job; production: Job }
  on: {
    workflow_dispatch: {
      inputs: {
        confirmation: { required: boolean }
        environment: { options: string[] }
        release_mode: { default: string; options: string[]; required: boolean }
      }
    }
  }
  permissions: Record<string, string>
}

const raw = readFileSync('.github/workflows/deploy-pornvideodownloaders.yml', 'utf8')
const workflow = yaml.load(raw) as Workflow

function githubExpression(expression: string): string {
  return `$${`{{ ${expression} }}`}`
}

describe('pornvideodownloaders.com deployment workflow', () => {
  it('keeps every executable identity distinct between active sites', () => {
    expect(siteIds).toEqual(['pornvideodownloaders.com', 'serp.software'])
    const pvd = siteTargets['pornvideodownloaders.com']
    const serp = siteTargets['serp.software']
    const pvdIdentities = [
      pvd.activePreview.databaseId,
      pvd.activePreview.databaseName,
      pvd.activePreview.workerName,
      pvd.appPackageName,
      pvd.artifactBatchDirectory,
      pvd.parityReportPath,
      pvd.local.configPath,
      pvd.local.databaseId,
      pvd.local.databaseName,
      pvd.local.workerName,
      pvd.remote.previewConfigPath,
      pvd.remote.productionConfigPath,
      pvd.protectedEnvironment.preview,
      pvd.protectedEnvironment.production
    ]
    const serpIdentities = [
      serp.activePreview.databaseId,
      serp.activePreview.databaseName,
      serp.activePreview.workerName,
      serp.appPackageName,
      serp.artifactBatchDirectory,
      serp.parityReportPath,
      serp.local.configPath,
      serp.local.databaseId,
      serp.local.databaseName,
      serp.local.workerName,
      serp.remote.previewConfigPath,
      serp.remote.productionConfigPath,
      serp.protectedEnvironment.preview,
      serp.protectedEnvironment.production
    ]

    expect(pvdIdentities.every((value, index) => value !== serpIdentities[index])).toBe(true)
    expect(JSON.stringify(pvd.confirmation)).not.toContain('serp.software')
    expect(JSON.stringify(serp.confirmation)).not.toContain('pornvideodownloaders.com')
  })

  it('rejects missing, unknown, and mismatched site selection', () => {
    expect(() => resolveSiteTarget(undefined)).toThrow('Site must be one of')
    expect(() => resolveSiteTarget('example.com')).toThrow('Site must be one of')
    expect(() => resolveRuntimeSiteId({})).toThrow('site selection has no default')
    expect(() =>
      resolveRuntimeSiteId({
        NEXT_PUBLIC_SITE_ID: 'pornvideodownloaders.com',
        SITE_ID: 'serp.software'
      })
    ).toThrow('does not match')
  })

  it('exposes only explicit preview and production protected targets', () => {
    expect(workflow.on.workflow_dispatch.inputs.environment.options).toEqual([
      'preview',
      'production'
    ])
    expect(workflow.on.workflow_dispatch.inputs.confirmation.required).toBe(true)
    expect(workflow.on.workflow_dispatch.inputs.release_mode).toEqual(
      expect.objectContaining({
        default: 'worker-only',
        options: ['worker-only', 'database-and-worker'],
        required: true
      })
    )
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(workflow.jobs.preview.environment.name).toBe('pornvideodownloaders-preview')
    expect(workflow.jobs.production.environment.name).toBe('pornvideodownloaders-production')
    expect(workflow.jobs.preview.if).toContain(
      "inputs.confirmation == 'deploy-pornvideodownloaders.com-preview'"
    )
    expect(workflow.jobs.production.if).toContain(
      "inputs.confirmation == 'deploy-pornvideodownloaders.com-production'"
    )
  })

  it('orders preview backup, migration, bootstrap verification, and deployment', () => {
    const environment = 'preview' as const
    const steps = workflow.jobs[environment].steps
    const backupIndex = steps.findIndex(step => step.name === `Back up ${environment} D1`)
    const mutationIndex = steps.findIndex(
      step => step.name === `Apply migrations, import, and verify ${environment} D1`
    )
    const deployIndex = steps.findIndex(
      step => step.name === `Verify schema compatibility and deploy ${environment} Worker`
    )
    expect([backupIndex, mutationIndex, deployIndex]).toEqual(
      [...[backupIndex, mutationIndex, deployIndex]].sort((left, right) => left - right)
    )
    const mutationSource = steps[mutationIndex]?.run || ''
    const orderedCommands = [
      `migrate ${environment} --site pornvideodownloaders.com`,
      `import ${environment} --site pornvideodownloaders.com`,
      `verify ${environment} --site pornvideodownloaders.com`
    ]
    const indexes = orderedCommands.map(command => mutationSource.indexOf(command))
    expect(indexes.every(index => index >= 0)).toBe(true)
    expect(indexes).toEqual([...indexes].sort((left, right) => left - right))
  })

  it('orders production backup, forward migration, and deployment without bootstrap replay', () => {
    const steps = workflow.jobs.production.steps
    const backupIndex = steps.findIndex(step => step.name === 'Back up production D1')
    const migrationIndex = steps.findIndex(step => step.name === 'Apply production D1 migrations')
    const deployIndex = steps.findIndex(
      step => step.name === 'Verify schema compatibility and deploy production Worker'
    )
    expect([backupIndex, migrationIndex, deployIndex]).toEqual(
      [...[backupIndex, migrationIndex, deployIndex]].sort((left, right) => left - right)
    )
    expect(steps[migrationIndex]?.run).toBe(
      'pnpm tsx scripts/worker-release.ts migrate production --site pornvideodownloaders.com'
    )
    expect(steps[migrationIndex]?.run).not.toContain('import production')
    expect(steps[migrationIndex]?.run).not.toContain('verify production')
  })

  it.each(['preview', 'production'] as const)(
    'makes every %s D1 operation opt-in while leaving Worker deployment unconditional',
    environment => {
      const steps = workflow.jobs[environment].steps
      const d1StepNames = new Set([
        'Plan remote migration and verification',
        `Back up ${environment} D1`,
        `Retain ${environment} D1 backup`,
        environment === 'preview'
          ? 'Apply migrations, import, and verify preview D1'
          : 'Apply production D1 migrations'
      ])

      for (const step of steps.filter(step => d1StepNames.has(step.name ?? ''))) {
        expect(step.if).toBe("inputs.release_mode == 'database-and-worker'")
      }
      expect(
        steps.find(
          step => step.name === `Verify schema compatibility and deploy ${environment} Worker`
        )?.if
      ).toBeUndefined()
    }
  )

  it.each(['preview', 'production'] as const)(
    'stops the %s deploy command when schema compatibility fails',
    environment => {
      const step = workflow.jobs[environment].steps.find(
        candidate =>
          candidate.name === `Verify schema compatibility and deploy ${environment} Worker`
      )
      const run = step?.run ?? ''
      expect(step?.['continue-on-error']).toBeUndefined()
      expect(run.startsWith('set -euo pipefail\n')).toBe(true)
      expect(run.indexOf(`check-schema ${environment}`)).toBeGreaterThan(0)
      expect(run.indexOf(`deploy ${environment}`)).toBeGreaterThan(
        run.indexOf(`check-schema ${environment}`)
      )
    }
  )

  it.each(['preview', 'production'] as const)(
    'keeps %s credentials scoped to remote execution steps',
    environment => {
      const steps = workflow.jobs[environment].steps
      const secretSteps = steps.filter(step => step.env?.CLOUDFLARE_API_TOKEN)
      expect(secretSteps.map(step => step.name)).toEqual([
        `Back up ${environment} D1`,
        environment === 'preview'
          ? 'Apply migrations, import, and verify preview D1'
          : 'Apply production D1 migrations',
        `Verify schema compatibility and deploy ${environment} Worker`
      ])
      expect(
        steps
          .filter(step => !step.env?.CLOUDFLARE_API_TOKEN)
          .every(step => !step.env?.WORKER_PRODUCTION_CONFIRM)
      ).toBe(true)
      const replacementPrefix = `CLOUDFLARE_D1_REPLACEMENT_${environment.toUpperCase()}`
      const canonicalPrefix = `CLOUDFLARE_D1_${environment.toUpperCase()}`
      for (const step of secretSteps) {
        expect(step.env?.D1_RELEASE_GENERATION).toBe('replatform')
        expect(step.env?.[`${replacementPrefix}_DATABASE_ID`]).toBe(
          githubExpression(`secrets.${replacementPrefix}_DATABASE_ID`)
        )
        expect(step.env?.[`${canonicalPrefix}_DATABASE_ID`]).toBeUndefined()
      }
      expect(
        steps.find(step => step.name === 'Plan remote migration and verification')?.env
          ?.D1_RELEASE_GENERATION
      ).toBe('replatform')
      expect(steps.find(step => step.name === `Retain ${environment} D1 backup`)?.with?.path).toBe(
        `.wrangler/backups/pornvideodownloaders-com/${environment}/${githubExpression('github.sha')}.replatform.sql`
      )
    }
  )
})

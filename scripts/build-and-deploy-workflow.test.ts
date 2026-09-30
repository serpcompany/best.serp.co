import { readFileSync } from 'node:fs'
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

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

const raw = readFileSync('.github/workflows/build-and-deploy.yml', 'utf8')
const workflow = yaml.load(raw) as Workflow

function githubExpression(expression: string): string {
  return `$${`{{ ${expression} }}`}`
}

describe('serp.software deployment workflow', () => {
  it('exposes only explicit protected Preview and Production targets', () => {
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
    expect(workflow.jobs.preview.environment.name).toBe('serp-software-preview')
    expect(workflow.jobs.production.environment.name).toBe('production')
    expect(workflow.jobs.preview.if).toContain("github.ref == 'refs/heads/main'")
    expect(workflow.jobs.preview.if).toContain(
      "inputs.confirmation == 'deploy-serp.software-preview'"
    )
    expect(workflow.jobs.production.if).toContain(
      "inputs.confirmation == 'deploy-serp.software-production'"
    )
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
    'orders %s backup, migration, schema proof, and deployment',
    environment => {
      const steps = workflow.jobs[environment].steps
      const backupIndex = steps.findIndex(step => step.name === `Back up ${environment} D1`)
      const migrationName =
        environment === 'preview'
          ? 'Apply migrations, import, and verify preview D1'
          : 'Apply production D1 migrations'
      const migrationIndex = steps.findIndex(step => step.name === migrationName)
      const deployIndex = steps.findIndex(
        step => step.name === `Verify schema compatibility and deploy ${environment} Worker`
      )
      expect([backupIndex, migrationIndex, deployIndex]).toEqual(
        [...[backupIndex, migrationIndex, deployIndex]].sort((left, right) => left - right)
      )
      const deploy = steps[deployIndex]
      expect(deploy?.['continue-on-error']).toBeUndefined()
      expect(deploy?.run?.startsWith('set -euo pipefail\n')).toBe(true)
      expect(deploy?.run?.indexOf(`check-schema ${environment}`)).toBeGreaterThan(0)
      expect(deploy?.run?.indexOf(`deploy ${environment}`)).toBeGreaterThan(
        deploy?.run?.indexOf(`check-schema ${environment}`) ?? -1
      )
    }
  )

  it('uses only the active replacement Preview identity and fresh Drizzle lineage', () => {
    const steps = workflow.jobs.preview.steps
    const secretSteps = steps.filter(step => step.env?.CLOUDFLARE_API_TOKEN)
    expect(secretSteps.map(step => step.name)).toEqual([
      'Verify active Preview identities read-only',
      'Back up preview D1',
      'Apply migrations, import, and verify preview D1',
      'Verify schema compatibility and deploy preview Worker'
    ])
    for (const step of secretSteps) {
      expect(step.env?.D1_RELEASE_GENERATION).toBe('replatform')
      expect(step.env?.CLOUDFLARE_D1_REPLACEMENT_PREVIEW_DATABASE_ID).toBe(
        githubExpression('secrets.CLOUDFLARE_D1_REPLACEMENT_PREVIEW_DATABASE_ID')
      )
      expect(step.env?.CLOUDFLARE_D1_REPLACEMENT_PREVIEW_DATABASE_NAME).toBe(
        githubExpression('secrets.CLOUDFLARE_D1_REPLACEMENT_PREVIEW_DATABASE_NAME')
      )
      expect(step.env?.CLOUDFLARE_D1_PREVIEW_DATABASE_ID).toBeUndefined()
      expect(step.env?.CLOUDFLARE_D1_PREVIEW_DATABASE_NAME).toBeUndefined()
      expect(step.env?.CLOUDFLARE_D1_REPLACEMENT_PRODUCTION_DATABASE_ID).toBeUndefined()
      expect(step.env?.CLOUDFLARE_WORKER_PRODUCTION_NAME).toBeUndefined()
      expect(step.env?.WORKER_PRODUCTION_CONFIRM).toBe(githubExpression('inputs.confirmation'))
    }
    const validation = steps.find(step => step.name === 'Validate repository and Worker contracts')
    expect(validation?.run).toContain(
      'worker-release.ts validate-replatform preview --site serp.software'
    )
    expect(
      steps.find(step => step.name === 'Plan remote migration and verification')?.env
        ?.D1_RELEASE_GENERATION
    ).toBe('replatform')
    expect(steps.find(step => step.name === 'Retain preview D1 backup')?.with?.path).toBe(
      `.wrangler/backups/serp-software/preview/${githubExpression('github.sha')}.replatform.sql`
    )
    expect(raw).not.toContain('CLOUDFLARE_D1_SOURCE_PREVIEW')
  })

  it('retains the pre-migration production backup', () => {
    const backupStep = workflow.jobs.production.steps.find(
      step => step.name === 'Retain production D1 backup'
    )
    expect(backupStep.uses).toBe('actions/upload-artifact@v7')
    expect(backupStep.with?.path).toBe(
      `.wrangler/backups/serp-software/production/${githubExpression('github.sha')}.replatform.sql`
    )
    expect(backupStep.with?.['if-no-files-found']).toBe('error')
  })

  it('observes the checked-in active identity before any remote Preview operation', () => {
    const steps = workflow.jobs.preview.steps
    const identityIndex = steps.findIndex(
      step => step.name === 'Verify active Preview identities read-only'
    )
    const remoteOperationIndexes = [
      'Back up preview D1',
      'Apply migrations, import, and verify preview D1',
      'Verify schema compatibility and deploy preview Worker'
    ].map(name => steps.findIndex(step => step.name === name))
    expect(identityIndex).toBeGreaterThan(-1)
    expect(steps[identityIndex]?.if).toBeUndefined()
    expect(steps[identityIndex]?.run).toBe(
      'pnpm tsx scripts/d1-routine-preview-identity.ts verify --site serp.software'
    )
    expect(remoteOperationIndexes.every(index => index > identityIndex)).toBe(true)
  })

  it('runs bounded Preview-only route and browser smoke after deployment and retains evidence', () => {
    const steps = workflow.jobs.preview.steps
    const deployIndex = steps.findIndex(
      step => step.name === 'Verify schema compatibility and deploy preview Worker'
    )
    const smokeIndex = steps.findIndex(
      step => step.name === 'Run protected Preview route and browser smoke'
    )
    const evidenceIndex = steps.findIndex(step => step.name === 'Retain Preview smoke evidence')
    expect(deployIndex).toBeGreaterThan(-1)
    expect(smokeIndex).toBeGreaterThan(deployIndex)
    expect(evidenceIndex).toBeGreaterThan(smokeIndex)
    const smoke = steps[smokeIndex]
    expect(smoke.env?.PLAYWRIGHT_BASE_URL).toBe(githubExpression('vars.PREVIEW_BASE_URL'))
    expect(smoke.env?.PREVIEW_BASE_URL).toBe(githubExpression('vars.PREVIEW_BASE_URL'))
    expect(smoke.run).toContain('d1-preview-http-gates.ts preview serp.software')
    expect(smoke.run).toContain('tests/multisite-smoke.spec.ts --project=chromium')
    expect(smoke.run).not.toContain('production')
    const evidence = steps[evidenceIndex]
    expect(evidence.if).toBe('always()')
    expect(evidence.uses).toBe('actions/upload-artifact@v7')
    expect(evidence.with?.path).toContain('serp-preview-smoke/')
    expect(evidence.with?.path).toContain('apps/e2e/playwright-report/')
  })

  it('keeps Production credentials out of Preview and Preview credentials out of Production', () => {
    const previewEnvs = workflow.jobs.preview.steps.flatMap(step => Object.keys(step.env ?? {}))
    const productionEnvs = workflow.jobs.production.steps.flatMap(step =>
      Object.keys(step.env ?? {})
    )
    expect(previewEnvs.some(name => name.includes('PRODUCTION_DATABASE'))).toBe(false)
    expect(previewEnvs).not.toContain('CLOUDFLARE_WORKER_PRODUCTION_NAME')
    expect(productionEnvs.some(name => name.includes('PREVIEW_DATABASE'))).toBe(false)
    expect(productionEnvs).not.toContain('CLOUDFLARE_WORKER_PREVIEW_NAME')
  })
})

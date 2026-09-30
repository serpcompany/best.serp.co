/**
 * The single deployment target this repository builds: best.serp.co.
 * Scripts import this instead of resolving a site id.
 */
export const project = {
  appDirectory: 'apps/web',
  appPackageName: 'web',
  artifact: {
    batchDirectory: 'd1/artifacts/best-serp-co-v1-import',
    name: 'best-serp-co-v1',
    parityReportPath: 'd1/artifacts/best-serp-co-v1-parity.yaml'
  },
  confirmation: {
    publish: 'publish-best.serp.co-production',
    submission: 'approve-best.serp.co-submission-production'
  },
  domain: 'best.serp.co',
  local: {
    databaseId: '00000000-0000-0000-0000-000000000001',
    databaseName: 'best-serp-co-local',
    workerName: 'best-serp-co-local'
  },
  protectedEnvironment: {
    production: 'production',
    staging: 'staging'
  },
  publicUrl: 'https://best.serp.co',
  wranglerConfigPath: 'apps/web/wrangler.jsonc'
} as const

export type Project = typeof project

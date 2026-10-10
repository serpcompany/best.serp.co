/**
 * The single deployment target this repository builds: best.serp.co.
 * Scripts import this instead of resolving a site id.
 */
export const project = {
  appDirectory: 'apps/web',
  /** The app's code: routes, components, logic (serp repository-layout.md, #172). */
  sourceDirectory: 'apps/web/src',
  appPackageName: 'web',
  /** Typed confirmations the protected workflows require. */
  confirmation: {
    deploy: 'deploy-best.serp.co-production',
    /** Owner-approved Worker hotfix from main that skips the staging check; see RELEASE_GUARDS. */
    hotfix: 'hotfix-best.serp.co-production',
    /** Listing media uploads from a reviewed plan (#95), staging first, then production. */
    mediaUpload: 'upload-media-best.serp.co-production',
    mediaUploadStaging: 'upload-media-best.serp.co-staging',
    publish: 'publish-best.serp.co-production',
    /** A reviewed manifest applied to staging first (#95): every catalog change is checked there. */
    publishStaging: 'publish-best.serp.co-staging'
  },
  domain: 'best.serp.co',
  /**
   * Wrangler's applied-migration ledger. Every D1 binding in `wrangler.jsonc` declares it as
   * `migrations_table`, and release tooling reads it to compare applied and pending migrations.
   */
  migrationsTable: 'd1_migrations',
  local: {
    databaseId: 'local-only-do-not-deploy',
    databaseName: 'best-serp-co-local',
    /** Local listing media (#95): Wrangler state only; the Worker serves it at `/_media`. */
    media: { baseUrl: '/_media', bucket: 'best-serp-co-media-local' },
    workerName: 'best-serp-co-local'
  },
  protectedEnvironment: {
    production: 'production',
    staging: 'staging'
  },
  publicUrl: 'https://best.serp.co',
  /**
   * Remote Worker and D1 identities, mirrored from `env.staging` / `env.production` in
   * `wrangler.jsonc` (IDs are not secrets). Release tooling refuses a config that differs.
   */
  remote: {
    production: {
      databaseId: '404ec437-53a2-4fbc-8b5f-b5e69065708e',
      databaseName: 'best-serp-co-production',
      /** The `cdn` bucket serp.co already uses; best.serp.co writes only under `best.serp.co/`. */
      media: { baseUrl: 'https://cdn.serp.co', bucket: 'cdn' },
      origin: 'https://best.serp.co',
      /** The production Worker's noindex workers.dev host, which CI's HTTP gates go through. */
      reviewOrigin: 'https://best-serp-co-production.serpcompany.workers.dev',
      workerName: 'best-serp-co-production',
      workersDev: true
    },
    staging: {
      databaseId: '8e6b67e5-9c58-4fa9-aca1-25b0020c0833',
      databaseName: 'best-serp-co-staging',
      /** A separate bucket, so staging can never overwrite production objects (#95). */
      media: { baseUrl: 'https://cdn-staging.serp.co', bucket: 'cdn-staging' },
      /** Staging's branded canonical host (#323), the Worker's Custom Domain in `wrangler.jsonc`. */
      origin: 'https://staging.best.serp.co',
      /** The staging Worker's noindex workers.dev host, which CI's HTTP gates and smoke go through. */
      reviewOrigin: 'https://best-serp-co-staging.serpcompany.workers.dev',
      workerName: 'best-serp-co-staging',
      workersDev: true
    }
  },
  repository: 'serpcompany/best.serp.co',
  /** Worker entry: the edge HTML cache in front of the generated `.open-next/worker.js`. */
  workerEntryPath: 'apps/web/worker.ts',
  wranglerConfigPath: 'apps/web/wrangler.jsonc'
} as const

export type Project = typeof project
export type RemoteEnvironment = keyof typeof project.remote

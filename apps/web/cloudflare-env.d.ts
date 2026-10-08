interface D1Result<T> {
  error?: string
  meta?: {
    duration?: number
    rows_read?: number
    rows_written?: number
    [key: string]: unknown
  }
  results: T[]
  success: boolean
}

interface D1PreparedStatement {
  all<T>(): Promise<D1Result<T>>
  bind(...values: unknown[]): D1PreparedStatement
  first<T>(): Promise<T | null>
  run(): Promise<D1Result<unknown>>
}

interface D1Database {
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>
  prepare(query: string): D1PreparedStatement
}

/** The subset of Workers' R2 bucket binding the media code uses (#95). */
interface R2ObjectBody {
  arrayBuffer(): Promise<ArrayBuffer>
  body: ReadableStream
  httpEtag: string
  httpMetadata?: { cacheControl?: string; contentType?: string }
  size: number
}

interface R2Bucket {
  delete(key: string): Promise<void>
  get(key: string): Promise<R2ObjectBody | null>
  put(
    key: string,
    value: Uint8Array,
    options?: {
      customMetadata?: Record<string, string>
      httpMetadata?: { cacheControl?: string; contentType?: string }
      sha256?: string
    }
  ): Promise<unknown>
}

interface CloudflareEnv {
  ASSETS: { fetch(request: Request): Promise<Response> }
  /** Worker secret on staging and production; `apps/web/.dev.vars` locally (docs/DEVELOPMENT.md). */
  BETTER_AUTH_SECRET?: string
  /** Comma-separated https origins Better Auth accepts besides `BETTER_AUTH_URL`. */
  BETTER_AUTH_TRUSTED_ORIGINS?: string
  /** The Worker's public origin; unset locally (the request's localhost origin is used). */
  BETTER_AUTH_URL?: string
  /** `on` 308s the production Worker's workers.dev host to best.serp.co (production only). */
  CANONICAL_HOST_REDIRECT?: 'on' | 'off'
  /** Cloudflare Access application AUD tag for /admin and /api/admin (lib/auth/cloudflare-access.ts). */
  CF_ACCESS_AUD?: string
  /** `on` requires Cloudflare Access locally or on staging; production always requires it. */
  CF_ACCESS_REQUIRED?: 'on' | 'off'
  /** Zero Trust team domain, `<team>.cloudflareaccess.com`. */
  CF_ACCESS_TEAM_DOMAIN?: string
  DB: D1Database
  D1_RUNTIME_ENV: 'local' | 'staging' | 'production'
  /**
   * Listing media (#95): the bucket ingestion writes (`cdn-staging` on staging, `cdn` in
   * production, local state locally). Pages read objects from `MEDIA_BASE_URL`, not through it.
   */
  MEDIA?: R2Bucket
  /** The media host pages build image URLs on (`https://cdn.serp.co`, …; `/_media` locally). */
  MEDIA_BASE_URL?: string
  /**
   * `on` turns orders (#68) on for a local Worker while `features.orders` is off
   * (`lib/billing/flags.ts`; unused since #133 turned the flag on). Ignored anywhere but local.
   */
  LOCAL_ORDERS?: string
  /** A local Worker only: the port of the end-to-end suite's mocked Stripe API on 127.0.0.1. */
  LOCAL_STRIPE_MOCK_PORT?: string
  /** Worker secret (#68): Stripe's secret key, test mode on staging and live in production. */
  STRIPE_SECRET_KEY?: string
  /** Worker secret (#68): the signing secret of the `/api/billing/webhook/` endpoint. */
  STRIPE_WEBHOOK_SECRET?: string
  /** Staging only: comma-separated recipients email may go to (`lib/email/config.ts`). */
  EMAIL_STAGING_ALLOWLIST?: string
  /** Crawl and analytics policy; anything but `production` is non-production. */
  SITE_ENVIRONMENT?: 'local' | 'staging' | 'production'
  /** Worker secret: the useSend API key (staging and production; local logs mail). */
  USESEND_API_KEY?: string
  /** The useSend instance origin, `https://app.usesend.com` (staging and production). */
  USESEND_BASE_URL?: string
  /** This environment's own Worker, which OpenNext calls through (wrangler.jsonc `services`). */
  WORKER_SELF_REFERENCE: { fetch(request: Request): Promise<Response> }
}

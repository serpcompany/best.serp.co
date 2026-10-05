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

interface CloudflareEnv {
  AUTH_TRUST_HOST: 'true'
  ASSETS: { fetch(request: Request): Promise<Response> }
  /** `on` 308s the production Worker's workers.dev host to best.serp.co (production only). */
  CANONICAL_HOST_REDIRECT?: 'on' | 'off'
  DB: D1Database
  D1_RUNTIME_ENV: 'local' | 'staging' | 'production'
  /** Staging only: comma-separated recipients email may go to (`lib/email/config.ts`). */
  EMAIL_STAGING_ALLOWLIST?: string
  /** Crawl and analytics policy; anything but `production` is non-production. */
  SITE_ENVIRONMENT?: 'local' | 'staging' | 'production'
  /** Worker secret: the useSend API key (staging and production; local logs mail). */
  USESEND_API_KEY?: string
  /** The useSend instance origin, `https://app.usesend.com` (staging and production). */
  USESEND_BASE_URL?: string
}

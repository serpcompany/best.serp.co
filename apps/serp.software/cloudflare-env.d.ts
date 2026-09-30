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
  DB: D1Database
  D1_RUNTIME_ENV: 'local' | 'preview' | 'production'
  NEXT_PUBLIC_SITE_ID: 'serp.software'
  SITE_ID: 'serp.software'
}

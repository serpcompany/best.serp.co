import { createSign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveCheckedInSiteConfig } from '@serpdirectory/site-contract'
import { activeCheckedInSiteIds } from '@serpdirectory/site-contract/active-site-ids'

type ServiceAccount = {
  client_email: string
  private_key: string
}

type SitemapTarget = {
  domain: string
  sitemapUrl: string
}

type SubmitGscArgs = {
  deleteSitemapUrls: string[]
  dryRun: boolean
  listSitemaps: boolean
  siteIds: string[]
  submitCanonical: boolean
  verifyCredentials: boolean
}

const webmastersScope = 'https://www.googleapis.com/auth/webmasters'

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url')
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

export function getSitemapTargets(siteIds: string[] = []): SitemapTarget[] {
  const targetSiteIds = siteIds.length > 0 ? siteIds : [...activeCheckedInSiteIds]

  return targetSiteIds.map(siteId => {
    const siteConfig = resolveCheckedInSiteConfig(siteId)

    return {
      domain: siteConfig.site.domain,
      sitemapUrl: `${normalizeBaseUrl(siteConfig.site.publicUrl)}/sitemap-index.xml`
    }
  })
}

function parseArgs(argv: string[]): SubmitGscArgs {
  const args: SubmitGscArgs = {
    deleteSitemapUrls: [],
    dryRun: false,
    listSitemaps: false,
    siteIds: [],
    submitCanonical: true,
    verifyCredentials: false
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]

    if (arg === '--') {
      continue
    }

    if (arg === '--dry-run') {
      args.dryRun = true
      continue
    }

    if (arg === '--no-submit') {
      args.submitCanonical = false
      continue
    }

    if (arg === '--verify-credentials') {
      args.submitCanonical = false
      args.verifyCredentials = true
      continue
    }

    if (arg === '--list-sitemaps') {
      args.submitCanonical = false
      args.listSitemaps = true
      continue
    }

    if (arg === '--site' && argv[index + 1]) {
      args.siteIds.push(argv[index + 1])
      index += 1
      continue
    }

    if (arg === '--delete-sitemap' && argv[index + 1]) {
      args.deleteSitemapUrls.push(argv[index + 1])
      index += 1
      continue
    }

    throw new Error(`Unknown argument: ${arg}`)
  }

  if (
    !args.submitCanonical &&
    !args.verifyCredentials &&
    !args.listSitemaps &&
    args.deleteSitemapUrls.length === 0
  ) {
    throw new Error('Nothing to do. Remove --no-submit or pass --delete-sitemap <url>.')
  }

  return args
}

function parseDeleteSitemapUrls(value: string | undefined): string[] {
  if (!value) {
    return []
  }

  return value
    .split(/[\n,]/)
    .map(url => url.trim())
    .filter(Boolean)
}

function parseSiteIds(value: string | undefined): string[] {
  if (!value) {
    return []
  }

  return value
    .split(/[\n,]/)
    .map(siteId => siteId.trim())
    .filter(Boolean)
}

function loadServiceAccount(env: NodeJS.ProcessEnv): ServiceAccount | undefined {
  if (env.GSC_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(env.GSC_SERVICE_ACCOUNT_JSON) as ServiceAccount
  }

  if (env.GOOGLE_APPLICATION_CREDENTIALS) {
    return JSON.parse(readFileSync(env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8')) as ServiceAccount
  }

  return undefined
}

async function getOauthRefreshTokenAccessToken(
  env: NodeJS.ProcessEnv
): Promise<string | undefined> {
  const clientId = env.GSC_OAUTH_CLIENT_ID
  const clientSecret = env.GSC_OAUTH_CLIENT_SECRET
  const refreshToken = env.GSC_OAUTH_REFRESH_TOKEN

  if (!clientId && !clientSecret && !refreshToken) {
    return undefined
  }

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      'Incomplete OAuth credentials. Set GSC_OAUTH_CLIENT_ID, GSC_OAUTH_CLIENT_SECRET, and GSC_OAUTH_REFRESH_TOKEN.'
    )
  }

  const response = await fetch('https://oauth2.googleapis.com/token', {
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken
    }),
    method: 'POST'
  })

  if (!response.ok) {
    throw new Error(
      `Failed to refresh Google OAuth access token: ${response.status} ${await response.text()}`
    )
  }

  const body = (await response.json()) as { access_token?: string }
  if (!body.access_token) {
    throw new Error('Google OAuth refresh response did not include access_token')
  }

  return body.access_token
}

function siteUrlFor(domain: string, env: NodeJS.ProcessEnv): string {
  const siteUrlMap = env.GSC_SITE_URL_MAP
    ? (JSON.parse(env.GSC_SITE_URL_MAP) as Record<string, string>)
    : {}

  return siteUrlMap[domain] ?? `https://${domain}/`
}

async function getAccessToken(env: NodeJS.ProcessEnv): Promise<string> {
  if (env.GSC_ACCESS_TOKEN) {
    return env.GSC_ACCESS_TOKEN
  }

  const oauthAccessToken = await getOauthRefreshTokenAccessToken(env)
  if (oauthAccessToken) {
    return oauthAccessToken
  }

  const serviceAccount = loadServiceAccount(env)
  if (!serviceAccount?.client_email || !serviceAccount.private_key) {
    throw new Error(
      'Missing GSC credentials. Set OAuth refresh credentials, GSC_SERVICE_ACCOUNT_JSON, GOOGLE_APPLICATION_CREDENTIALS, or GSC_ACCESS_TOKEN.'
    )
  }

  const now = Math.floor(Date.now() / 1000)
  const unsignedJwt = [
    base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })),
    base64Url(
      JSON.stringify({
        aud: 'https://oauth2.googleapis.com/token',
        exp: now + 3600,
        iat: now,
        iss: serviceAccount.client_email,
        scope: webmastersScope
      })
    )
  ].join('.')
  const signature = createSign('RSA-SHA256').update(unsignedJwt).sign(serviceAccount.private_key)
  const assertion = `${unsignedJwt}.${base64Url(signature)}`

  const response = await fetch('https://oauth2.googleapis.com/token', {
    body: new URLSearchParams({
      assertion,
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer'
    }),
    method: 'POST'
  })

  if (!response.ok) {
    throw new Error(
      `Failed to fetch Google access token: ${response.status} ${await response.text()}`
    )
  }

  const body = (await response.json()) as { access_token?: string }
  if (!body.access_token) {
    throw new Error('Google token response did not include access_token')
  }

  return body.access_token
}

function authorizationHeaders(accessToken: string, env: NodeJS.ProcessEnv): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`
  }

  if (env.GSC_QUOTA_PROJECT) {
    headers['x-goog-user-project'] = env.GSC_QUOTA_PROJECT
  }

  return headers
}

async function verifyCredentialAuthority(
  accessToken: string,
  env: NodeJS.ProcessEnv
): Promise<void> {
  const response = await fetch('https://www.googleapis.com/webmasters/v3/sites', {
    headers: authorizationHeaders(accessToken, env)
  })

  if (!response.ok) {
    throw new Error(
      `Failed to verify Search Console credential authority: ${response.status} ${await response.text()}`
    )
  }
}

async function submitSitemap(
  accessToken: string,
  siteUrl: string,
  sitemapUrl: string,
  env: NodeJS.ProcessEnv
): Promise<void> {
  const endpoint = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(
    siteUrl
  )}/sitemaps/${encodeURIComponent(sitemapUrl)}`
  const response = await fetch(endpoint, {
    headers: authorizationHeaders(accessToken, env),
    method: 'PUT'
  })

  if (!response.ok) {
    throw new Error(
      `Failed to submit ${sitemapUrl} for ${siteUrl}: ${response.status} ${await response.text()}`
    )
  }
}

async function listSitemaps(
  accessToken: string,
  siteUrl: string,
  env: NodeJS.ProcessEnv
): Promise<void> {
  const endpoint = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(
    siteUrl
  )}/sitemaps`
  const response = await fetch(endpoint, {
    headers: authorizationHeaders(accessToken, env)
  })

  if (!response.ok) {
    throw new Error(
      `Failed to list registered sitemaps for ${siteUrl}: ${response.status} ${await response.text()}`
    )
  }

  const body = (await response.json()) as {
    sitemap?: Array<{
      isPending?: boolean
      isSitemapsIndex?: boolean
      lastSubmitted?: string
      path?: string
    }>
  }

  for (const sitemap of body.sitemap ?? []) {
    if (!sitemap.path) {
      continue
    }

    console.log(
      `SITEMAP ${siteUrl} -> ${sitemap.path} ` +
        `(index=${sitemap.isSitemapsIndex ?? false}, pending=${sitemap.isPending ?? false}, ` +
        `lastSubmitted=${sitemap.lastSubmitted ?? 'unknown'})`
    )
  }
}

async function deleteSitemap(
  accessToken: string,
  siteUrl: string,
  sitemapUrl: string,
  env: NodeJS.ProcessEnv
): Promise<void> {
  const endpoint = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(
    siteUrl
  )}/sitemaps/${encodeURIComponent(sitemapUrl)}`
  const response = await fetch(endpoint, {
    headers: authorizationHeaders(accessToken, env),
    method: 'DELETE'
  })

  if (response.status === 404 || response.status === 410) {
    return
  }

  if (!response.ok) {
    throw new Error(
      `Failed to delete ${sitemapUrl} for ${siteUrl}: ${response.status} ${await response.text()}`
    )
  }
}

function deleteTargetsForSitemapUrls(sitemapUrls: string[]): SitemapTarget[] {
  return sitemapUrls.map(sitemapUrl => {
    const parsedUrl = new URL(sitemapUrl)

    return {
      domain: parsedUrl.hostname,
      sitemapUrl
    }
  })
}

export async function runSubmitGscSitemaps(
  argv = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const args = parseArgs(argv)
  const siteIds = args.siteIds.length > 0 ? args.siteIds : parseSiteIds(env.GSC_SITE_IDS)
  const deleteSitemapUrls = [
    ...args.deleteSitemapUrls,
    ...parseDeleteSitemapUrls(env.GSC_STALE_SITEMAP_URLS),
    ...parseDeleteSitemapUrls(env.GSC_DELETE_SITEMAP_URLS)
  ]
  const submitTargets = args.submitCanonical ? getSitemapTargets(siteIds) : []
  const listTargets = args.listSitemaps ? getSitemapTargets(siteIds) : []
  const deleteTargets = deleteTargetsForSitemapUrls([...new Set(deleteSitemapUrls)])

  if (args.dryRun) {
    for (const target of deleteTargets) {
      console.log(`DELETE ${siteUrlFor(target.domain, env)} -> ${target.sitemapUrl}`)
    }
    for (const target of submitTargets) {
      console.log(`SUBMIT ${siteUrlFor(target.domain, env)} -> ${target.sitemapUrl}`)
    }
    for (const target of listTargets) {
      console.log(`LIST ${siteUrlFor(target.domain, env)}`)
    }
    return
  }

  const accessToken = await getAccessToken(env)

  if (args.verifyCredentials) {
    await verifyCredentialAuthority(accessToken, env)
    console.log('Verified Search Console credential authority without mutation.')
    return
  }

  for (const target of listTargets) {
    await listSitemaps(accessToken, siteUrlFor(target.domain, env), env)
  }

  for (const target of deleteTargets) {
    const siteUrl = siteUrlFor(target.domain, env)
    await deleteSitemap(accessToken, siteUrl, target.sitemapUrl, env)
    console.log(`Deleted ${target.sitemapUrl} for ${siteUrl}`)
  }

  for (const target of submitTargets) {
    const siteUrl = siteUrlFor(target.domain, env)
    await submitSitemap(accessToken, siteUrl, target.sitemapUrl, env)
    console.log(`Submitted ${target.sitemapUrl} for ${siteUrl}`)
  }
}

const invokedAsScript = process.argv.some(arg => {
  const resolvedArg = resolve(arg)
  return (
    resolvedArg === fileURLToPath(import.meta.url) ||
    resolvedArg.endsWith('/scripts/submit-gsc-sitemaps.ts') ||
    resolvedArg.endsWith('/submit-gsc-sitemaps.ts')
  )
})
const invokedAsCommonJsScript =
  typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module

if (invokedAsScript || invokedAsCommonJsScript) {
  runSubmitGscSitemaps().catch(error => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}

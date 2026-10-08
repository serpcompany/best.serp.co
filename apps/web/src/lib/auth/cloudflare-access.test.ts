import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { isAdminPath } from './admin-gate'
import {
  ACCESS_JWT_HEADER,
  type AccessEnv,
  accessConfig,
  accessRequired,
  verifyAccessRequest
} from './cloudflare-access'

const TEAM = 'serpcompany.cloudflareaccess.com'
const AUD = 'a'.repeat(64)
const productionEnv: AccessEnv = {
  CF_ACCESS_AUD: AUD,
  CF_ACCESS_TEAM_DOMAIN: TEAM,
  SITE_ENVIRONMENT: 'production'
}

let signingKey: CryptoKey
let otherKey: CryptoKey
let jwks: { keys: JWK[] }

beforeAll(async () => {
  const pair = await generateKeyPair('RS256')
  const other = await generateKeyPair('RS256')
  signingKey = pair.privateKey
  otherKey = other.privateKey
  jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), alg: 'RS256', kid: 'access-key' }] }
})

const localKeys = () => createLocalJWKSet(jwks)

async function token(
  claims: Record<string, unknown> = {},
  options: { expiresIn?: string; key?: CryptoKey; issuer?: string; audience?: string } = {}
): Promise<string> {
  return new SignJWT({ email: 'devin@serp.co', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'access-key' })
    .setIssuer(options.issuer ?? `https://${TEAM}`)
    .setAudience(options.audience ?? AUD)
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? '5m')
    .sign(options.key ?? signingKey)
}

function request(jwt?: string): Request {
  return new Request('https://best.serp.co/admin/', {
    headers: jwt ? { [ACCESS_JWT_HEADER]: jwt } : {}
  })
}

describe('Cloudflare Access JWT validation', () => {
  it('requires Access in production and wherever the environment is not explicit', () => {
    expect(accessRequired({ SITE_ENVIRONMENT: 'production' })).toBe(true)
    expect(accessRequired({ SITE_ENVIRONMENT: 'production', CF_ACCESS_REQUIRED: 'off' })).toBe(true)
    expect(accessRequired({})).toBe(true)
    expect(accessRequired({ SITE_ENVIRONMENT: 'Production' })).toBe(true)
    expect(accessRequired({ SITE_ENVIRONMENT: 'staging' })).toBe(false)
    expect(accessRequired({ SITE_ENVIRONMENT: 'staging', CF_ACCESS_REQUIRED: 'on' })).toBe(true)
    expect(accessRequired({ SITE_ENVIRONMENT: 'local' })).toBe(false)
    expect(accessRequired({ SITE_ENVIRONMENT: 'local', CF_ACCESS_REQUIRED: 'on' })).toBe(true)
  })

  it('accepts only a well-formed team domain and AUD tag', () => {
    expect(accessConfig(productionEnv)).toEqual({
      audience: AUD,
      certsUrl: `https://${TEAM}/cdn-cgi/access/certs`,
      issuer: `https://${TEAM}`
    })
    expect(accessConfig({ ...productionEnv, CF_ACCESS_TEAM_DOMAIN: `https://${TEAM}/` })).not.toBe(
      null
    )
    for (const broken of [
      { CF_ACCESS_TEAM_DOMAIN: '' },
      { CF_ACCESS_AUD: '' },
      { CF_ACCESS_TEAM_DOMAIN: 'evil.example.com' },
      { CF_ACCESS_TEAM_DOMAIN: 'serpcompany.cloudflareaccess.com.evil.example' },
      { CF_ACCESS_AUD: 'not-an-aud-tag' }
    ]) {
      expect(accessConfig({ ...productionEnv, ...broken }), JSON.stringify(broken)).toBeNull()
    }
  })

  it('fails closed in production when the Access vars are missing', async () => {
    for (const env of [
      { SITE_ENVIRONMENT: 'production' },
      { ...productionEnv, CF_ACCESS_AUD: '' },
      { ...productionEnv, CF_ACCESS_TEAM_DOMAIN: '' }
    ]) {
      expect(await verifyAccessRequest(request(await token()), env, { getKey: localKeys })).toEqual(
        { status: 'not-configured' }
      )
    }
  })

  it('accepts a valid token signed by the team key for this application', async () => {
    expect(
      await verifyAccessRequest(request(await token()), productionEnv, { getKey: localKeys })
    ).toEqual({ email: 'devin@serp.co', status: 'verified' })
  })

  it('rejects a missing, foreign, expired, or forged token', async () => {
    expect(await verifyAccessRequest(request(), productionEnv, { getKey: localKeys })).toEqual({
      status: 'missing'
    })
    const invalid = [
      await token({}, { audience: 'b'.repeat(64) }),
      await token({}, { issuer: 'https://other.cloudflareaccess.com' }),
      await token({}, { key: otherKey }),
      await token({}, { expiresIn: '-10m' }),
      'not.a.jwt',
      `${(await token()).slice(0, -4)}AAAA`
    ]
    for (const jwt of invalid) {
      const decision = await verifyAccessRequest(request(jwt), productionEnv, {
        getKey: localKeys
      })
      expect(decision.status, jwt).toBe('invalid')
    }
    // An HS256 token signed with the public key as a secret must not pass (algorithm pinning).
    const hs256 = await new SignJWT({ email: 'devin@serp.co' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(`https://${TEAM}`)
      .setAudience(AUD)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(JSON.stringify(jwks.keys[0])))
    expect(
      (await verifyAccessRequest(request(hs256), productionEnv, { getKey: localKeys })).status
    ).toBe('invalid')
  })

  it('is not consulted on local or staging unless the flag is on', async () => {
    expect(await verifyAccessRequest(request(), { SITE_ENVIRONMENT: 'staging' })).toEqual({
      status: 'not-required'
    })
    expect(
      await verifyAccessRequest(request(), {
        CF_ACCESS_REQUIRED: 'on',
        SITE_ENVIRONMENT: 'staging'
      })
    ).toEqual({ status: 'not-configured' })
  })

  it('leaves the Access vars for the owner to fill in, and the flag off on staging', () => {
    const config = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../../../wrangler.jsonc'), 'utf8')
    ) as {
      env: Record<'production' | 'staging', { vars: Record<string, string> }>
      vars: Record<string, string>
    }
    expect(config.vars.CF_ACCESS_REQUIRED).toBeUndefined()
    expect(config.env.staging.vars.CF_ACCESS_REQUIRED).toBe('off')
    expect(config.env.production.vars.CF_ACCESS_REQUIRED).toBeUndefined()
    for (const environment of ['staging', 'production'] as const) {
      expect(Object.keys(config.env[environment].vars)).toEqual(
        expect.arrayContaining(['CF_ACCESS_AUD', 'CF_ACCESS_TEAM_DOMAIN'])
      )
    }
  })
})

// The default key resolver: the team's JWKS fetched from /cdn-cgi/access/certs (round 2,
// finding 6). Each test uses its own team domain, because key sets are cached per certs URL.
describe('Cloudflare Access remote JWKS', () => {
  afterEach(() => vi.unstubAllGlobals())

  function teamEnv(team: string): AccessEnv {
    return { CF_ACCESS_AUD: AUD, CF_ACCESS_TEAM_DOMAIN: team, SITE_ENVIRONMENT: 'production' }
  }

  async function teamToken(team: string): Promise<string> {
    return token({}, { issuer: `https://${team}` })
  }

  it('verifies a token against the keys served at the team certs URL', async () => {
    const team = 'jwks-ok.cloudflareaccess.com'
    const fetched: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        fetched.push(String(input instanceof Request ? input.url : input))
        return Response.json(jwks)
      })
    )
    expect(await verifyAccessRequest(request(await teamToken(team)), teamEnv(team))).toEqual({
      email: 'devin@serp.co',
      status: 'verified'
    })
    expect(fetched).toEqual([`https://${team}/cdn-cgi/access/certs`])
  })

  it.each([
    ['the fetch fails', async () => Promise.reject(new TypeError('network down'))],
    ['the certs URL answers 404', async () => new Response('<html>', { status: 404 })],
    ['the body is not a key set', async () => Response.json({ keys: 'nope' })],
    ['no key matches the kid', async () => Response.json({ keys: [] })]
  ])('fails closed when %s', async (label, answer) => {
    const team = `jwks-${label.replace(/\W+/gu, '-')}.cloudflareaccess.com`.replace(/-+\./u, '.')
    vi.stubGlobal('fetch', vi.fn(answer))
    const decision = await verifyAccessRequest(request(await teamToken(team)), teamEnv(team))
    expect(decision.status).toBe('invalid')
  })
})

describe('admin path matching', () => {
  it('covers /admin and /api/admin in every spelling a router might accept', () => {
    for (const path of [
      '/admin',
      '/admin/',
      '/admin/submissions/1/',
      '/api/admin',
      '/api/admin/listings',
      '/ADMIN/',
      '/Api/Admin/x',
      '/%61dmin/',
      '//admin/',
      '/api//admin/x',
      '/%E0%A4%A/'
    ]) {
      expect(isAdminPath(path), path).toBe(true)
    }
    for (const path of [
      '/',
      '/administrator/',
      '/products/admin/',
      '/api/auth/get-session',
      '/adminx'
    ]) {
      expect(isAdminPath(path), path).toBe(false)
    }
  })
})

/**
 * The admin gate's answer to a request without a session cookie (serpcompany/best.serp.co#488):
 * an `/admin` page read goes to sign-in and back, while `/api/admin` and every other method keep
 * the plain 401. Access and the staging admin key come first (`handle-request.test.ts` covers
 * them through the Worker pipeline).
 */
import { describe, expect, it } from 'vitest'
import {
  ADMIN_PAGE_PATH_HEADER,
  adminGate,
  adminPageReturnPath,
  withAdminPagePath
} from './admin-gate'
import { safeCallbackPath } from './callback-url'
import { STAGING_ADMIN_KEY_HEADER } from './staging-admin-key'

const ORIGIN = 'http://localhost:8787'
const LOCAL = { SITE_ENVIRONMENT: 'local' }
const SESSION = 'better-auth.session_token=token.signature'

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`${ORIGIN}${path}`, init)
}

/** Where a sign-in redirect returns to, as the login page reads it. */
function callbackOf(response: Response | null): string | null {
  const location = response?.headers.get('location')
  return location ? new URL(location, ORIGIN).searchParams.get('callbackUrl') : null
}

describe('admin gate without a session cookie (#488)', () => {
  it('sends a GET or HEAD for an admin page to sign-in, then back with its query', async () => {
    for (const path of [
      '/admin/',
      '/admin/submissions/sub_1/',
      '/admin/submissions/?status=waiting&page=2',
      '/admin/not-a-page/'
    ]) {
      for (const method of ['GET', 'HEAD']) {
        const response = await adminGate(
          request(path, { headers: { cookie: 'theme=dark' }, method }),
          LOCAL
        )
        const label = `${method} ${path}`
        expect(response?.status, label).toBe(303)
        expect(response?.headers.get('location'), label).toBe(
          `/login/?callbackUrl=${encodeURIComponent(path)}`
        )
        expect(response?.headers.get('cache-control'), label).toBe('private, no-store')
        expect(response?.headers.get('x-robots-tag'), label).toBe('noindex, nofollow')
        expect(await response?.text(), label).toBe('')
        // The login page accepts it as it is.
        expect(safeCallbackPath(callbackOf(response)), label).toBe(path)
      }
    }
  })

  it('keeps the 401 for /api/admin, and for every method that is not a read', async () => {
    const refusals: [method: string, path: string][] = [
      ['GET', '/api/admin'],
      ['GET', '/api/admin/listings/lst_1'],
      ['HEAD', '/API/Admin/'],
      ['POST', '/api/admin/admins'],
      ['POST', '/admin/'],
      ['PUT', '/admin/submissions/sub_1/'],
      ['PATCH', '/admin/listings/'],
      ['DELETE', '/admin/admins/'],
      ['OPTIONS', '/admin/']
    ]
    for (const [method, path] of refusals) {
      const response = await adminGate(request(path, { method }), LOCAL)
      expect(response?.status, `${method} ${path}`).toBe(401)
      expect(await response?.text(), `${method} ${path}`).toBe('Unauthorized\n')
      expect(response?.headers.get('location'), `${method} ${path}`).toBeNull()
    }
  })

  it('returns to an encoded or differently spelled admin path as it was requested', async () => {
    for (const path of [
      '/admin/listings/caf%C3%A9/',
      '/ADMIN/submissions/',
      '/%61dmin/submissions/',
      '/admin%2Fsubmissions/'
    ]) {
      const response = await adminGate(request(path), LOCAL)
      expect(response?.status, path).toBe(303)
      expect(callbackOf(response), path).toBe(path)
      expect(safeCallbackPath(callbackOf(response)), path).toBe(path)
    }
    // A path that cannot be decoded is still gated, but names no page to return to.
    const undecodable = await adminGate(request('/admin/%E0%A4%A/'), LOCAL)
    expect(undecodable?.status).toBe(401)
  })

  it('drops the Next.js router marker from the page it returns to', async () => {
    expect(callbackOf(await adminGate(request('/admin/listings/?_rsc=1a2b3'), LOCAL))).toBe(
      '/admin/listings/'
    )
    expect(callbackOf(await adminGate(request('/admin/listings/?q=a+b&_rsc=1a2b3'), LOCAL))).toBe(
      '/admin/listings/?q=a+b'
    )
  })

  it('passes a session cookie on, and judges the staging admin key before the cookie', async () => {
    expect(await adminGate(request('/admin/', { headers: { cookie: SESSION } }), LOCAL)).toBeNull()
    // The key is never good on a page, and outside staging nowhere: 401, never sign-in.
    for (const cookie of [undefined, SESSION]) {
      const response = await adminGate(
        request('/admin/submissions/', {
          headers: { ...(cookie ? { cookie } : {}), [STAGING_ADMIN_KEY_HEADER]: 'any-key' }
        }),
        LOCAL
      )
      expect(response?.status).toBe(401)
      expect(response?.headers.get('location')).toBeNull()
    }
  })

  it('leaves every other path alone', async () => {
    for (const path of ['/', '/login/', '/administrator/', '/api/administrator']) {
      expect(await adminGate(request(path), LOCAL), path).toBeNull()
    }
  })
})

describe("an admin page's own path for requireAdmin() (#488)", () => {
  it('is the page path and query of a GET or HEAD, and nothing else', () => {
    expect(adminPageReturnPath(request('/admin/orders/?page=3'))).toBe('/admin/orders/?page=3')
    expect(adminPageReturnPath(request('/admin/', { method: 'HEAD' }))).toBe('/admin/')
    expect(adminPageReturnPath(request('/admin/', { method: 'POST' }))).toBeNull()
    expect(adminPageReturnPath(request('/api/admin/listings'))).toBeNull()
    expect(adminPageReturnPath(request('/about/'))).toBeNull()
  })

  it("replaces a client's header on an admin page and removes it from every other request", () => {
    const spoofed = { [ADMIN_PAGE_PATH_HEADER]: '/elsewhere/' }
    const page = withAdminPagePath(
      request('/admin/submissions/sub_1/?tab=media&_rsc=x', { headers: spoofed })
    )
    expect(page.headers.get(ADMIN_PAGE_PATH_HEADER)).toBe('/admin/submissions/sub_1/?tab=media')
    for (const other of [
      request('/api/admin/listings', { headers: spoofed }),
      request('/admin/', { headers: spoofed, method: 'POST' }),
      request('/about/', { headers: spoofed })
    ]) {
      expect(withAdminPagePath(other).headers.has(ADMIN_PAGE_PATH_HEADER), other.url).toBe(false)
    }
    const untouched = request('/about/')
    expect(withAdminPagePath(untouched)).toBe(untouched)
  })
})

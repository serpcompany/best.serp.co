import { readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AppEmailTemplates } from '../registry'
import { EMAIL_SAMPLES, renderAppEmail } from './samples'

/**
 * Every link in every email must open a page that exists (#64 link audit). A link to a page
 * another issue still has to build is allowed only while it is listed in `DEFERRED` with that
 * issue, and only in emails nothing sends yet; the emails the admin panel sends (#64) have none.
 * When a deferred page lands, its entry fails here until it is removed.
 */

type TemplateId = keyof AppEmailTemplates

const ORIGIN = 'https://best.serp.co'
const APP_DIRECTORY = resolve(__dirname, '../../../app')

/** Links to pages other issues build, by template (each email that links there). */
const DEFERRED: Partial<Record<TemplateId, Array<{ issue: string; path: RegExp }>>> = {
  'admin-new-message': [{ issue: '#73', path: /^\/admin\/inbox\/[^/]+\/$/u }],
  'badge-missing': [{ issue: '#65', path: /^\/account\/listings\/[^/]+\/$/u }],
  'draft-reminder': [
    { issue: '#63', path: /^\/submit\/[^/]+\/choose\/$/u },
    { issue: '#68', path: /^\/submit\/[^/]+\/checkout\/$/u }
  ],
  'listing-unlisted': [{ issue: '#65', path: /^\/account\/listings\/[^/]+\/$/u }],
  'new-message': [{ issue: '#73', path: /^\/account\/messages\/[^/]+\/$/u }]
}

/** The emails the admin panel sends today. */
const SENT_BY_ADMIN_PANEL: TemplateId[] = [
  'changes-requested',
  'listing-approved',
  'submission-rejected',
  'submission-rejected-prohibited'
]

/** Route patterns of the app's pages and route handlers (catch-all 404 pages excluded). */
function appRoutes(): RegExp[] {
  const routes: RegExp[] = []
  const visit = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name)
      if (statSync(path).isDirectory()) {
        visit(path)
        continue
      }
      if (!/^(?:page|route)\.tsx?$/u.test(name)) continue
      const segments = relative(APP_DIRECTORY, directory)
        .split(/[\\/]/u)
        .filter(segment => segment && !/^\(.+\)$/u.test(segment))
      // Catch-alls answer 404 for unknown paths, and the root `[slug]` page only redirects
      // legacy listing URLs, so neither makes a link valid.
      if (segments.some(segment => segment.startsWith('[...') || segment.startsWith('[[...'))) {
        continue
      }
      if (segments.length === 1 && segments[0] === '[slug]') continue
      const pattern = segments
        .map(segment => (/^\[.+\]$/u.test(segment) ? '[^/]+' : segment.replace(/\./gu, '\\.')))
        .join('/')
      routes.push(new RegExp(`^/${pattern}${pattern ? '/' : ''}$`, 'u'))
    }
  }
  visit(APP_DIRECTORY)
  return routes
}

function siteLinks(html: string): string[] {
  return [...html.matchAll(/\shref="([^"]+)"/gu)]
    .map(match => match[1] ?? '')
    .filter(href => href === ORIGIN || href.startsWith(`${ORIGIN}/`))
    .map(href => new URL(href).pathname)
}

describe('email links', () => {
  const routes = appRoutes()
  const exists = (path: string) => routes.some(route => route.test(path))

  it('finds the pages the emails rely on', () => {
    for (const path of ['/', '/account/', '/contact/', '/submit/', '/products/x.example/']) {
      expect(exists(path), path).toBe(true)
    }
    expect(exists('/account/messages/new/')).toBe(false)
  })

  it('links only to pages that exist, apart from the listed deferred pages', () => {
    const problems: string[] = []
    const deferredSeen = new Set<string>()
    for (const [id, samples] of Object.entries(EMAIL_SAMPLES) as Array<
      [TemplateId, Array<{ input: unknown; to: string }>]
    >) {
      for (const sample of samples) {
        const email = renderAppEmail(id, sample.input as never, {
          environment: 'production',
          to: sample.to
        })
        for (const path of siteLinks(email.html)) {
          if (exists(path)) continue
          const deferred = DEFERRED[id]?.find(entry => entry.path.test(path))
          if (deferred) {
            deferredSeen.add(`${id} ${deferred.path}`)
            continue
          }
          problems.push(`${id}: ${path}`)
        }
      }
    }
    expect(problems).toEqual([])
    // A deferred page that now exists, or a template that stopped linking there, is removed
    // from the list.
    const listed = Object.entries(DEFERRED).flatMap(([id, entries]) =>
      (entries ?? []).map(entry => `${id} ${entry.path}`)
    )
    expect(listed.filter(entry => !deferredSeen.has(entry))).toEqual([])
  })

  it('sends nothing from the admin panel that links to a page still to be built', () => {
    for (const id of SENT_BY_ADMIN_PANEL) expect(DEFERRED[id], id).toBeUndefined()
  })
})

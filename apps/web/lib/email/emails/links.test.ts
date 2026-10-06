import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { site } from '@serpdirectory/site-config'
import { describe, expect, it } from 'vitest'
import { features, type SiteFeatures } from '../../features'
import { type AppEmailTemplates, appEmailTemplates } from '../registry'
import { SIGN_IN_CODE_TEMPLATE } from '../sign-in-code'
import { EMAIL_SAMPLES, renderAppEmail } from './samples'

/**
 * Emails promise only what the site can do (#64 link and copy audit):
 * - every link opens a page that exists. A link to a page another issue still has to build is
 *   allowed only while it is listed in `DEFERRED` with that issue, and only in emails nothing
 *   sends yet. When a deferred page lands, its entry fails here until it is removed.
 * - an email the app sends never asks for a dashboard action whose area is still off in
 *   `lib/features.ts` (editing a submission before #65, replying before #73). Flagged copy
 *   switches back to the approved wording when the issue turns its flag on, and the links that
 *   come back with it must then exist.
 */

type TemplateId = keyof AppEmailTemplates

const ORIGIN = 'https://best.serp.co'
const WEB_DIRECTORY = resolve(__dirname, '../../..')
const APP_DIRECTORY = join(WEB_DIRECTORY, 'app')

/** Links to pages other issues build, by template (each email that links there). */
const DEFERRED: Partial<Record<TemplateId, Array<{ issue: string; path: RegExp }>>> = {
  'admin-new-message': [{ issue: '#73', path: /^\/admin\/inbox\/[^/]+\/$/u }],
  'badge-missing': [{ issue: '#65', path: /^\/account\/listings\/[^/]+\/$/u }],
  'listing-unlisted': [{ issue: '#65', path: /^\/account\/listings\/[^/]+\/$/u }],
  'new-message': [{ issue: '#73', path: /^\/account\/messages\/[^/]+\/$/u }]
}

/** Copy that asks for something only a later site area can do, by its flag. */
const DASHBOARD_PROMISES: ReadonlyArray<{
  feature: keyof SiteFeatures
  issue: string
  pattern: RegExp
}> = [
  {
    feature: 'accountDashboard',
    issue: '#65',
    pattern:
      /\bresubmit\b|\bedit the submission\b|\b(?:open|view) submission\b|(?<!\bmessage us )\bfrom your dashboard\b/iu
  },
  {
    feature: 'messages',
    issue: '#73',
    pattern:
      /\breply to the reviewer\b|\bmessage us from\b|\bopen conversation\b|\bin your dashboard to read\b|\bopen in inbox\b/iu
  }
]

/**
 * Copy the owner approved while its area is still off, by template. It is exempt from
 * `DASHBOARD_PROMISES` word for word; anything else in that email is still checked.
 */
const APPROVED_INTERIM_COPY: Partial<Record<TemplateId, RegExp[]>> = {
  // Owner decision on #64 (2026-10-06): a changes-requested submission is fixed and resubmitted
  // from the account area (`/account/`), whose editing #65 builds.
  'changes-requested': [/\bresubmit from your account\b/giu]
}

/** Templates sent through a constant rather than a literal id. */
const SENT_THROUGH_CONSTANTS: TemplateId[] = [SIGN_IN_CODE_TEMPLATE]

/** App source outside the email module (tests excluded). */
function senderSources(): string[] {
  const sources: string[] = []
  const visit = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name)
      if (statSync(path).isDirectory()) {
        if (name !== 'node_modules' && path !== join(WEB_DIRECTORY, 'lib', 'email')) visit(path)
        continue
      }
      if (/\.tsx?$/u.test(name) && !/\.test\.tsx?$/u.test(name)) {
        sources.push(readFileSync(path, 'utf8'))
      }
    }
  }
  for (const directory of ['app', 'components', 'lib']) visit(join(WEB_DIRECTORY, directory))
  return sources
}

/** The emails the app sends today: every template whose id app code names. */
function sentTemplates(): Set<TemplateId> {
  const sources = senderSources()
  const ids = Object.keys(appEmailTemplates) as TemplateId[]
  return new Set([
    ...SENT_THROUGH_CONSTANTS,
    ...ids.filter(id => sources.some(code => code.includes(`'${id}'`)))
  ])
}

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

type Rendered = { html: string; subject: string; text: string }

/**
 * A sample's input as the app sends it. The draft reminder's paid copy and its checkout link
 * (#68) follow `site.features.showPaidListings`, which the draft job passes as `paidListings`
 * (#63), so it renders here with the site's flag rather than the mockups' `true`.
 */
function sentInput(id: TemplateId, input: unknown): unknown {
  if (id !== 'draft-reminder') return input
  return { ...(input as object), paidListings: site.features.showPaidListings }
}

/** Every sample of every template, rendered in production with the given site areas. */
function renderAll(siteFeatures: SiteFeatures): Array<{ email: Rendered; id: TemplateId }> {
  return (
    Object.entries(EMAIL_SAMPLES) as Array<[TemplateId, Array<{ input: unknown; to: string }>]>
  ).flatMap(([id, samples]) =>
    samples.map(sample => ({
      email: renderAppEmail(id, sentInput(id, sample.input) as never, {
        environment: 'production',
        features: siteFeatures,
        to: sample.to
      }),
      id
    }))
  )
}

/**
 * The words an email says to its reader: subject, inbox preview, and the body above the
 * footer. The footer is the same in every email and belongs to the template contract
 * (`templates.ts`).
 */
function copyOf(email: Rendered): string {
  const preheader = /display:none[^"]*">([^<]*)<\/div>/u.exec(email.html)?.[1] ?? ''
  return [email.subject, preheader, email.text.split('\n--\n')[0] ?? ''].join('\n')
}

function promisesIn(email: Rendered, id: TemplateId): Array<keyof SiteFeatures> {
  const copy = (APPROVED_INTERIM_COPY[id] ?? []).reduce(
    (text, approved) => text.replace(approved, ''),
    copyOf(email)
  )
  return DASHBOARD_PROMISES.filter(promise => promise.pattern.test(copy)).map(
    promise => promise.feature
  )
}

const ALL_OFF: SiteFeatures = { accountDashboard: false, messages: false, orders: false }
const ALL_ON: SiteFeatures = { accountDashboard: true, messages: true, orders: true }

describe('email links', () => {
  const routes = appRoutes()
  const exists = (path: string) => routes.some(route => route.test(path))
  const sent = sentTemplates()

  it('finds the pages the emails rely on', () => {
    for (const path of ['/', '/account/', '/contact/', '/submit/', '/products/x.example/']) {
      expect(exists(path), path).toBe(true)
    }
    expect(exists('/account/messages/new/')).toBe(false)
  })

  it('finds the emails the app sends', () => {
    for (const id of [
      'changes-requested',
      'listing-approved',
      SIGN_IN_CODE_TEMPLATE,
      'submission-rejected',
      'submission-rejected-prohibited'
    ] as const) {
      expect(sent.has(id), id).toBe(true)
    }
  })

  it('links only to pages that exist, apart from the listed deferred pages', () => {
    const problems: string[] = []
    const deferredSeen = new Set<string>()
    for (const { email, id } of renderAll(features)) {
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
    expect(problems).toEqual([])
    // A deferred page that now exists, or a template that stopped linking there, is removed
    // from the list.
    const listed = Object.entries(DEFERRED).flatMap(([id, entries]) =>
      (entries ?? []).map(entry => `${id} ${entry.path}`)
    )
    expect(listed.filter(entry => !deferredSeen.has(entry))).toEqual([])
  })

  it('sends nothing that links to a page still to be built', () => {
    for (const id of sent) expect(DEFERRED[id], id).toBeUndefined()
  })
})

describe('email copy', () => {
  const sent = sentTemplates()

  it('promises no dashboard action in an email the app sends while its area is off', () => {
    const problems = renderAll(features)
      .filter(({ id }) => sent.has(id))
      .flatMap(({ email, id }) =>
        promisesIn(email, id)
          .filter(feature => !features[feature])
          .map(feature => {
            const issue = DASHBOARD_PROMISES.find(promise => promise.feature === feature)?.issue
            return `${id}: promises ${feature} (${issue}) while it is off`
          })
      )
    expect(problems).toEqual([])
  })

  it('switches the flagged copy with its flags: interim wording off, approved wording on', () => {
    const flagged: Partial<Record<TemplateId, Array<keyof SiteFeatures>>> = {
      'changes-requested': ['accountDashboard', 'messages'],
      'submission-rejected': ['accountDashboard'],
      'submission-rejected-prohibited': ['messages']
    }
    const off = renderAll(ALL_OFF)
    const on = renderAll(ALL_ON)
    for (const [id, expected] of Object.entries(flagged) as Array<
      [TemplateId, Array<keyof SiteFeatures>]
    >) {
      const before = off.find(entry => entry.id === id)
      const after = on.find(entry => entry.id === id)
      expect(before && promisesIn(before.email, id), id).toEqual([])
      expect(after && promisesIn(after.email, id), id).toEqual(expected)
    }
  })

  it('exempts only the owner-approved interim copy, and only where it is used', () => {
    const off = renderAll(ALL_OFF)
    for (const [id, phrases] of Object.entries(APPROVED_INTERIM_COPY) as Array<
      [TemplateId, RegExp[]]
    >) {
      const email = off.find(entry => entry.id === id)?.email
      for (const phrase of phrases) {
        // Still present (or the exemption is removed), and a promise without the exemption.
        expect(email && copyOf(email).match(phrase), `${id} ${phrase}`).not.toBeNull()
        expect(
          DASHBOARD_PROMISES.some(promise => email && promise.pattern.test(copyOf(email))),
          `${id} ${phrase}`
        ).toBe(true)
      }
    }
  })
})

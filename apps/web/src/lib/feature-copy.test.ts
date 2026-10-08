import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { featureCopy } from './feature-copy'
import { features, type SiteFeatures } from './features'

/**
 * Pages promise only what the site can do (PR #84 review round 4), as the email audit
 * (`email/emails/links.test.ts`) does for emails: submitter-facing copy that needs a later site
 * area lives in `feature-copy.ts` behind that area's flag, and no page or component says it
 * anywhere else while the flag is off. Scanned: `app/`, `components/`, `lib/submissions/` (its
 * messages reach the submitter), `lib/account/` (the dashboard's, #65), and
 * `lib/site` and `content/about` (site copy, including the About page). The admin panel is left out: its copy describes listing states to the team, not what
 * a submitter can do.
 */

const WEB_DIRECTORY = resolve(__dirname, '..')
const SCANNED = [
  join(WEB_DIRECTORY, 'app'),
  join(WEB_DIRECTORY, 'components'),
  join(WEB_DIRECTORY, 'lib', 'submissions'),
  join(WEB_DIRECTORY, 'lib', 'account'),
  join(WEB_DIRECTORY, 'lib', 'site'),
  join(WEB_DIRECTORY, '..', 'content', 'about')
]

const PAGE_PROMISES: ReadonlyArray<{
  feature: keyof SiteFeatures
  issue: string
  /** Only sources under these paths make the promise (default: every scanned source). */
  paths?: RegExp
  pattern: RegExp
}> = [
  {
    feature: 'accountDashboard',
    issue: '#65',
    pattern: /\bFAQs?\b|\bresubmit\b|\bedit the submission\b/iu
  },
  {
    feature: 'badgeProgram',
    issue: '#66',
    pattern: /\bevery week\b|\bweekly\b|\bcheck again about 24 hours\b/iu
  },
  {
    // The account's FAQ fields (#65): the listing page shows FAQs once #105 ships. The same
    // words describe the long description elsewhere, so only the account's pages are checked.
    feature: 'listingFaqs',
    issue: '#105',
    paths: /^components\/account\//u,
    pattern: /\bshown on your listing page\b/iu
  }
]

/**
 * Copy the owner approved while its area is still off, by file, exempt word for word (as
 * `APPROVED_INTERIM_COPY` in the email audit).
 */
const APPROVED_INTERIM_COPY: Record<string, RegExp[]> = {}

const ALL_OFF: SiteFeatures = {
  accountDashboard: false,
  badgeProgram: false,
  claims: false,
  listingFaqs: false,
  messages: false,
  orders: false
}
const ALL_ON: SiteFeatures = {
  accountDashboard: true,
  badgeProgram: true,
  claims: true,
  listingFaqs: true,
  messages: true,
  orders: true
}

/** The scanned sources outside the admin panel, without tests or code comments. */
function pageSources(): Array<{ code: string; path: string }> {
  const sources: Array<{ code: string; path: string }> = []
  const visit = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name)
      if (statSync(path).isDirectory()) {
        if (name !== 'admin' && name !== 'node_modules') visit(path)
        continue
      }
      if (!/\.(?:tsx?|mdx?)$/u.test(name) || /\.test\.tsx?$/u.test(name)) continue
      const file = relative(WEB_DIRECTORY, path)
      const code = (APPROVED_INTERIM_COPY[file] ?? []).reduce(
        (text, approved) => text.replace(approved, ''),
        readFileSync(path, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//gu, '')
          .replace(/^\s*\/\/.*$/gmu, '')
      )
      sources.push({ code, path: file })
    }
  }
  for (const directory of SCANNED) visit(directory)
  return sources
}

describe('page copy', () => {
  it('exempts only approved interim copy that is still there', () => {
    for (const [file, phrases] of Object.entries(APPROVED_INTERIM_COPY)) {
      const code = readFileSync(join(WEB_DIRECTORY, file), 'utf8')
      for (const phrase of phrases) expect(code.match(phrase), `${file} ${phrase}`).not.toBeNull()
    }
  })

  it('reads the submit pages', () => {
    const paths = pageSources().map(source => source.path)
    expect(paths).toContain('components/submit/badge-step.tsx')
    expect(paths).toContain('components/submit/submit-form.tsx')
    expect(paths).toContain('lib/submissions/contract.ts')
    expect(paths).toContain('../../../apps/web/src/lib/site/site.ts')
    expect(paths).toContain('../../../apps/web/content/about/about.mdx')
    expect(paths.some(path => path.includes('admin'))).toBe(false)
  })

  it('promises no site area whose flag is off outside feature-copy.ts', () => {
    const problems = pageSources().flatMap(({ code, path }) =>
      PAGE_PROMISES.filter(promise => !features[promise.feature])
        .filter(promise => !promise.paths || promise.paths.test(path))
        .filter(promise => promise.pattern.test(code))
        .map(promise => `${path}: promises ${promise.feature} (${promise.issue}) while it is off`)
    )
    expect(problems).toEqual([])
  })

  it('leaves each promise out while its flag is off and brings the approved copy back on', () => {
    const off = JSON.stringify(featureCopy(ALL_OFF))
    const copyPromises = PAGE_PROMISES.filter(promise => !promise.paths)
    expect(copyPromises.filter(promise => promise.pattern.test(off))).toEqual([])
    expect(featureCopy(ALL_OFF)).toEqual({
      addFaqsAndLinks: null,
      badgePanel: {
        cadence: null,
        cardNote: 'Free listings keep the badge on their site',
        description: 'Free listing',
        failingNote: null,
        failingTitle: 'Fix the badge',
        programCheckBy: 'SERP'
      },
      claim: { badgeCardNote: null, keepTheBadge: null },
      contentHint: 'Shown on your listing page.',
      faqsHint: null,
      freePlanBadgeCheck: null,
      keepTheBadgeUp: null
    })
    // The #70 mockups' wording, word for word.
    expect(featureCopy(ALL_ON)).toEqual({
      addFaqsAndLinks: {
        description: 'From your account while the listing is in review.',
        title: 'Add FAQs and links'
      },
      badgePanel: {
        cadence: 'Weekly',
        cardNote: 'Free listings are checked weekly',
        description: 'Free listing · checked weekly',
        failingNote:
          'If it’s still failing at the recheck about 24 hours later, the listing is unlisted.',
        failingTitle: 'Fix the badge before the recheck',
        programCheckBy: 'Weekly'
      },
      claim: {
        badgeCardNote:
          'We check it weekly. If it’s removed, you lose ownership and the listing stays up.',
        keepTheBadge:
          'We check it weekly. If it’s missing on two checks about 24 hours apart, ownership is removed. The listing stays up.'
      },
      contentHint:
        'Shown on your listing page. FAQs and links can be added from your account later.',
      faqsHint: 'Shown on your listing page.',
      freePlanBadgeCheck: 'Keep the badge up: we check it every week',
      keepTheBadgeUp: {
        description:
          'We check it every week. If it goes missing, we email you and check again about 24 hours later.',
        title: 'Keep the badge up'
      }
    })
    // Until #105 shows FAQs on listing pages, the account says they will appear soon.
    expect(featureCopy({ ...ALL_ON, listingFaqs: false }).faqsHint).toBe(
      'FAQs will appear on your listing page soon.'
    )
    for (const feature of ['accountDashboard', 'badgeProgram'] as const) {
      const one = JSON.stringify(featureCopy({ ...ALL_OFF, [feature]: true }))
      expect(
        copyPromises.filter(promise => promise.pattern.test(one)).map(promise => promise.feature)
      ).toEqual([feature])
    }
  })

  it('shows the approved badge program wording with the site’s flags (#130)', () => {
    // The owner turned the badge program (#66) and claims (#67) on (#130), then orders (#68,
    // #133); messages (#73) stay off.
    expect(features).toMatchObject({ badgeProgram: true, claims: true, orders: true })
    const shipped = featureCopy()
    const approved = featureCopy(ALL_ON)
    expect(shipped.badgePanel).toEqual(approved.badgePanel)
    expect(shipped.claim).toEqual(approved.claim)
    expect(shipped.freePlanBadgeCheck).toBe('Keep the badge up: we check it every week')
    expect(shipped.keepTheBadgeUp).toEqual(approved.keepTheBadgeUp)
  })
})

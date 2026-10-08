import type { WebsiteConflicts } from '@/db/billing'
import { validatePublicHttpUrl } from '@/db/public-url'
import { safeFetch } from '@/db/safe-fetch'

/**
 * The guardrail checks a paid submission passes before it goes live at payment (#68): the
 * website is a public address under the safe-fetch rules, it loads (an HTML page, through at most
 * three checked redirects, within the time limit), no listing already has it, and no prohibited
 * block covers it. A failure holds the submission for review instead of publishing it, and
 * `problem` finishes the approved "Payment received: in review" email's sentence "Our automatic
 * checks couldn't load <website> (<problem>)".
 */

export type GuardrailResult = { ok: true } | { code: string; ok: false; problem: string }

const MAX_PAGE_BYTES = 1_000_000

/** The email's parenthetical for each failure (the approved sample is the timeout's). */
export function guardrailProblem(code: string): string {
  if (code === 'fetch_timeout') return 'the connection timed out'
  const status = /^http_(\d{3})$/u.exec(code)
  if (status) return `it answered with HTTP ${status[1]}`
  switch (code) {
    case 'invalid_target':
      return 'it isn’t a public web address'
    case 'invalid_redirect':
      return 'it redirected to an address we don’t check'
    case 'too_many_redirects':
      return 'it redirected too many times'
    case 'response_too_large':
      return 'the page was too large'
    case 'unexpected_type':
      return 'it didn’t answer with a web page'
    case 'listed':
      return 'another listing already uses it'
    case 'blocked':
      return 'it’s blocked for prohibited content'
    default:
      return 'the site didn’t respond'
  }
}

export async function runGuardrails(input: {
  conflicts: (website: string) => Promise<WebsiteConflicts>
  fetcher?: typeof fetch
  website: string
}): Promise<GuardrailResult> {
  const fail = (code: string): GuardrailResult => ({
    code,
    ok: false,
    problem: guardrailProblem(code)
  })
  if (!validatePublicHttpUrl(input.website).ok) return fail('invalid_target')
  const conflicts = await input.conflicts(input.website)
  if (conflicts.blocked) return fail('blocked')
  if (conflicts.listed) return fail('listed')
  const page = await safeFetch(input.website, {
    accept: type => type === 'text/html' || type === 'application/xhtml+xml',
    acceptHeader: 'text/html,application/xhtml+xml',
    fetcher: input.fetcher,
    maxBytes: MAX_PAGE_BYTES
  })
  return page.ok ? { ok: true } : fail(page.code)
}

/**
 * The checkout page's parenthetical for the same failures (#70 screen 4e: "Our checks couldn't
 * load <website> (no response within 8 seconds)."). Only the timeout has approved page copy;
 * the others reuse the email's wording.
 */
export function checkoutPageProblem(code: string | null): string {
  return code === 'fetch_timeout' ? 'no response within 8 seconds' : guardrailProblem(code ?? '')
}

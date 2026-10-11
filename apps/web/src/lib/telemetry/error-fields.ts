/**
 * What a Worker log line says about a caught error (#211; serp telemetry standard, Required
 * Defaults item 3): a stable code and the error's name, never its message. A message can hold
 * user input: a claim's domain, a submission's text, an email address, or, from Drizzle, a failed
 * statement's bound values. Workers Logs keep these lines, so they follow the same rule as
 * Sentry (`scrubEvent`).
 *
 * It imports no package, so the Worker entry and `src/instrumentation.ts` can use it
 * (`server-errors.ts`) without loading Drizzle or Sentry.
 */
import { d1ErrorCode } from '../../db/error-code'
import { ERROR_CODES } from './sentry'

const STABLE_MESSAGES: ReadonlySet<string> = new Set(ERROR_CODES)
/** A code an error carries itself: `provider_unreachable`, `invalid_url`, `RATE_LIMITED`. */
const OWN_CODE = /^[A-Za-z][\w.:-]{0,63}$/u
const ERROR_NAME = /^[A-Za-z_$][\w$]{0,63}$/u

/**
 * The error's stable code, in order: its message when that is an allowlisted code; its own
 * `code` (`BillingProviderError`, `SubmissionError`, `EmailProviderError`); otherwise
 * `d1ErrorCode`, which names a D1 failure (`SQLITE_ERROR:too_many_variables`) and is `UNKNOWN`
 * for anything else.
 */
export function errorCode(error: unknown): string {
  if (error instanceof Error && STABLE_MESSAGES.has(error.message)) return error.message
  const own =
    typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
  if (typeof own === 'string' && OWN_CODE.test(own)) return own
  return d1ErrorCode(error)
}

/** The fields a log line spreads in for a caught error: `{ code, name }`. */
export function errorFields(error: unknown): { code: string; name?: string } {
  const name = error instanceof Error && ERROR_NAME.test(error.name) ? error.name : undefined
  return name ? { code: errorCode(error), name } : { code: errorCode(error) }
}

/**
 * An error's stack frames without the header line, which repeats the message (`Name: message`,
 * and Drizzle's message spans lines): only the `at` lines after it.
 */
export function stackFrames(error: Error): string | undefined {
  const { message, stack } = error
  if (!stack) return undefined
  const start = message && stack.includes(message) ? stack.indexOf(message) + message.length : 0
  const frames = stack
    .slice(start)
    .split('\n')
    .filter(line => /^\s+at /u.test(line))
  return frames.length > 0 ? frames.join('\n') : undefined
}

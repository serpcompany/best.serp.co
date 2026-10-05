/**
 * Where `/login` sends a visitor after signing in (serpcompany/best.serp.co#60). Only a path on
 * this site is accepted, so `?callbackUrl=` can never redirect off-site; anything else, and
 * `/login` itself, falls back to the account page.
 */

export const DEFAULT_CALLBACK_PATH = '/account/'

const PLACEHOLDER_ORIGIN = 'https://callback.invalid'

export function safeCallbackPath(value: string | string[] | null | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || /[\\\p{Cc}]/u.test(raw)) {
    return DEFAULT_CALLBACK_PATH
  }
  let url: URL
  try {
    url = new URL(raw, PLACEHOLDER_ORIGIN)
  } catch {
    return DEFAULT_CALLBACK_PATH
  }
  if (url.origin !== PLACEHOLDER_ORIGIN) return DEFAULT_CALLBACK_PATH
  if (/^\/login(?:\/|$)/iu.test(url.pathname)) return DEFAULT_CALLBACK_PATH
  return `${url.pathname}${url.search}${url.hash}`
}

/** How the signed-in screen names the destination. */
export interface CallbackDestination {
  /** The continue button: "Continue to Submit". */
  button: string
  /** The sentence after the signed-in email: "Taking you back to Submit." */
  sentence: string
}

export function callbackDestination(path: string): CallbackDestination {
  if (/^\/submit(?:\/|$)/u.test(path)) {
    return { button: 'Continue to Submit', sentence: 'Taking you back to Submit.' }
  }
  if (/^\/account(?:\/|$)/u.test(path)) {
    return { button: 'Continue to your account', sentence: 'Taking you to your account.' }
  }
  return { button: 'Continue', sentence: 'Taking you back to the page you were on.' }
}

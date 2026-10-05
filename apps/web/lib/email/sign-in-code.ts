/**
 * The sign-in code's contract between Better Auth, its email, and the `/login` screen
 * (serpcompany/best.serp.co#60, #61): the one place the template id, the code length, the code
 * lifetime, and the guesses per code are defined.
 *
 * - `lib/auth/rate-limits.ts` configures Better Auth's email OTP plugin with
 *   `SIGN_IN_CODE_LENGTH`, `SIGN_IN_CODE_TTL_SECONDS`, and `SIGN_IN_CODE_ATTEMPTS`.
 * - `components/auth/` (the `/login` screen) sizes the code input, words its copy, and counts
 *   attempts from the same values, so the screen cannot drift from Better Auth.
 * - `signInCodeDigits` normalizes a pasted or typed code the same way on the screen and in the
 *   sign-in hook.
 * - `lib/auth/otp-sender.ts` hands each code to `enqueueEmail('sign-in-code', ...)` with the
 *   lifetime in minutes, and the `sign-in-code` template (`emails/codes.ts`) refuses a code of
 *   any other length.
 *
 * `lib/auth` depends on `lib/email`, never the reverse. This module imports nothing, so the
 * auth configuration, its tests, and client components can load it outside the Worker.
 */

/** The stable id of the email that carries a sign-in code (`registry.ts`). */
export const SIGN_IN_CODE_TEMPLATE = 'sign-in-code'

/** Digits in a sign-in code. */
export const SIGN_IN_CODE_LENGTH = 6

/** How long a sign-in code works: ten minutes. */
export const SIGN_IN_CODE_TTL_SECONDS = 10 * 60

/** Guesses one code allows before Better Auth deletes it. */
export const SIGN_IN_CODE_ATTEMPTS = 3

/**
 * The digits of a code as someone pasted, typed, or autofilled it: every character that is not
 * 0-9 (spaces, NBSP, dashes, newlines, zero-width characters) is dropped, so "482 913",
 * "482-913", and " 482913\n" all become "482913". The `/login` code field applies it to every
 * input, and Better Auth's sign-in hook (`lib/auth/config.ts`) applies it again before
 * checking the code.
 */
export function signInCodeDigits(text: string): string {
  return text.replace(/[^0-9]/gu, '')
}

/** What the `sign-in-code` template renders. */
export interface SignInCodeInput {
  /** The code Better Auth generated (`sendVerificationOTP`'s `otp`). */
  code: string
  /** The code's lifetime in whole minutes, from `SIGN_IN_CODE_TTL_SECONDS`. */
  expiresInMinutes: number
}

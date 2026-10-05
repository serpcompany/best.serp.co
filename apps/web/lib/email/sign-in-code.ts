/**
 * The sign-in code's contract between Better Auth and its email (serpcompany/best.serp.co#60,
 * #61): the one place the template id, the code length, and the code lifetime are defined.
 *
 * - `lib/auth/rate-limits.ts` configures Better Auth's email OTP plugin with
 *   `SIGN_IN_CODE_LENGTH` and `SIGN_IN_CODE_TTL_SECONDS`.
 * - `lib/auth/otp-sender.ts` hands each code to `enqueueEmail('sign-in-code', ...)` with the
 *   lifetime in minutes, and the `sign-in-code` template (`emails/codes.ts`) refuses a code of
 *   any other length.
 *
 * `lib/auth` depends on `lib/email`, never the reverse. This module imports nothing, so the
 * auth configuration and its tests can load it outside the Worker.
 */

/** The stable id of the email that carries a sign-in code (`registry.ts`). */
export const SIGN_IN_CODE_TEMPLATE = 'sign-in-code'

/** Digits in a sign-in code. */
export const SIGN_IN_CODE_LENGTH = 6

/** How long a sign-in code works: ten minutes. */
export const SIGN_IN_CODE_TTL_SECONDS = 10 * 60

/** What the `sign-in-code` template renders. */
export interface SignInCodeInput {
  /** The code Better Auth generated (`sendVerificationOTP`'s `otp`). */
  code: string
  /** The code's lifetime in whole minutes, from `SIGN_IN_CODE_TTL_SECONDS`. */
  expiresInMinutes: number
}

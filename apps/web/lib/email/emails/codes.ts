/**
 * One-time code emails: the sign-in code and the claim domain-email code. The code goes in the
 * subject (owner decision, #70). Key each send per call, for example
 * `emailEventKey('sign-in-code', crypto.randomUUID())`: every code is a new event, and keys
 * must never be derived from the code.
 *
 * The code length and lifetime are shared constants: Better Auth's email OTP config (#72)
 * imports `SIGN_IN_CODE_LENGTH` and `SIGN_IN_CODE_TTL_SECONDS` from `../server`, so the email
 * always states the lifetime the auth layer enforces.
 */
import { clip, defineEmailTemplate, EmailTemplateError } from '../templates'
import { composeEmail, paragraph, required, SUBJECT_NAME_MAX } from './layout'

/** Digits in a sign-in code. */
export const SIGN_IN_CODE_LENGTH = 6
/** How long a sign-in code works: 10 minutes. */
export const SIGN_IN_CODE_TTL_SECONDS = 600
/** Digits in a claim domain-email code. */
export const CLAIM_CODE_LENGTH = 6
/** How long a claim code works: 10 minutes. */
export const CLAIM_CODE_TTL_SECONDS = 600

function digits(code: string, length: number): string {
  if (typeof code !== 'string' || !new RegExp(`^\\d{${length}}$`, 'u').test(code)) {
    throw new EmailTemplateError(`A code email needs a ${length}-digit code.`)
  }
  return code
}

function minutes(seconds: number): number {
  return Math.ceil(seconds / 60)
}

export interface SignInCodeInput {
  /** The code Better Auth generated (`sendVerificationOTP`'s `otp`). */
  code: string
  /**
   * Better Auth's OTP type. This email is for `sign-in` only; any other type is refused
   * (logged as `email_render_failed`), so the caller must not send it for those flows.
   */
  type: 'sign-in'
}

export const signInCodeEmail = defineEmailTemplate<SignInCodeInput>({
  id: 'sign-in-code',
  render(input, context) {
    if (input.type !== 'sign-in') {
      throw new EmailTemplateError('The sign-in code email is only for sign-in codes.')
    }
    const code = digits(input.code, SIGN_IN_CODE_LENGTH)
    const expires = minutes(SIGN_IN_CODE_TTL_SECONDS)
    const host = new URL(context.links.origin).host
    return composeEmail(
      {
        after: [
          paragraph(
            `It expires in ${expires} minutes and works once. If you didn’t try to sign in, you can ignore this email.`
          )
        ],
        body: [paragraph(`Enter this code on ${host} to sign in or create your account:`)],
        code,
        heading: 'Your sign-in code',
        preheader: `It expires in ${expires} minutes.`,
        reason: `You’re getting this because this address was entered at ${host}/login.`,
        subject: `${code} is your SERP sign-in code`
      },
      context
    )
  }
})

export interface ClaimCodeInput {
  code: string
  /** The listing being claimed. */
  listingName: string
}

export const claimCodeEmail = defineEmailTemplate<ClaimCodeInput>({
  id: 'claim-code',
  render(input, context) {
    const code = digits(input.code, CLAIM_CODE_LENGTH)
    const expires = minutes(CLAIM_CODE_TTL_SECONDS)
    const name = required(input.listingName, 'a listing name')
    const host = new URL(context.links.origin).host
    return composeEmail(
      {
        after: [
          paragraph(
            `It expires in ${expires} minutes. If you didn’t ask for this, ignore this email. Nobody can claim ${name} without the code.`
          )
        ],
        body: [
          paragraph(
            `A SERP account is claiming the ${name} listing and entered this address to show they work there. Enter this code to confirm:`
          )
        ],
        code,
        heading: `Confirm your email to claim ${name}`,
        preheader: `Confirm you work at ${name}.`,
        reason: `You’re getting this because this address was entered to claim a listing on ${host}.`,
        subject: `${code} is your SERP code to claim ${clip(name, SUBJECT_NAME_MAX)}`
      },
      context
    )
  }
})

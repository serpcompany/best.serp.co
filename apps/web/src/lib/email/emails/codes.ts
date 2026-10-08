/**
 * One-time code emails: the sign-in code and the claim domain-email code. The code goes in the
 * subject (owner decision, #70). Key each send per call, for example
 * `emailEventKey('sign-in-code', crypto.randomUUID())`: every code is a new event, and keys
 * must never be derived from the code.
 *
 * The sign-in code's length and lifetime live in `../sign-in-code.ts`, which Better Auth's
 * email OTP config (`lib/auth/rate-limits.ts`) imports. Better Auth's OTP sender
 * (`lib/auth/otp-sender.ts`) enqueues this email for sign-in codes only, with the lifetime it
 * enforces.
 */
import { SIGN_IN_CODE_LENGTH, SIGN_IN_CODE_TEMPLATE, type SignInCodeInput } from '../sign-in-code'
import { clip, defineEmailTemplate, EmailTemplateError } from '../templates'
import { composeEmail, paragraph, required, SUBJECT_NAME_MAX } from './layout'

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

/** A code's lifetime in minutes: a whole number from 1 to 60. */
function lifetime(expiresInMinutes: number): number {
  if (!Number.isInteger(expiresInMinutes) || expiresInMinutes < 1 || expiresInMinutes > 60) {
    throw new EmailTemplateError('A code email needs a lifetime of 1 to 60 whole minutes.')
  }
  return expiresInMinutes
}

export type { SignInCodeInput } from '../sign-in-code'

export const signInCodeEmail = defineEmailTemplate<SignInCodeInput>({
  id: SIGN_IN_CODE_TEMPLATE,
  render(input, context) {
    const code = digits(input.code, SIGN_IN_CODE_LENGTH)
    const expires = lifetime(input.expiresInMinutes)
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

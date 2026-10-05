/**
 * One-time code emails: the sign-in code and the claim domain-email code. The code goes in the
 * subject (owner decision, #70). Key each send per call, for example
 * `emailEventKey('sign-in-code', crypto.randomUUID())`: every code is a new event, and keys
 * must never be derived from the code.
 */
import { defineEmailTemplate, EmailTemplateError } from '../templates'
import { composeEmail, paragraph, required } from './layout'

const CODE = /^\d{6}$/u

function sixDigits(code: string): string {
  if (typeof code !== 'string' || !CODE.test(code)) {
    throw new EmailTemplateError('A code email needs a six-digit code.')
  }
  return code
}

function minutes(value: number | undefined): number {
  const count = value ?? 10
  if (!Number.isInteger(count) || count < 1) throw new EmailTemplateError('Expected minutes.')
  return count
}

export interface SignInCodeInput {
  /** The six-digit code Better Auth generated (`sendVerificationOTP`'s `otp`). */
  code: string
  /** How long the code lasts; 10 minutes unless the auth config says otherwise. */
  expiresInMinutes?: number
}

export const signInCodeEmail = defineEmailTemplate<SignInCodeInput>({
  id: 'sign-in-code',
  render(input, context) {
    const code = sixDigits(input.code)
    const expires = minutes(input.expiresInMinutes)
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
  expiresInMinutes?: number
  /** The listing being claimed. */
  listingName: string
}

export const claimCodeEmail = defineEmailTemplate<ClaimCodeInput>({
  id: 'claim-code',
  render(input, context) {
    const code = sixDigits(input.code)
    const expires = minutes(input.expiresInMinutes)
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
        subject: `${code} is your SERP code to claim ${name}`
      },
      context
    )
  }
})

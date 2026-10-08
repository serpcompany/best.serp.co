'use client'

import { ArrowRight, CircleX, Clock, Info } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import { readLocalDraft } from '@/components/submit/draft-storage'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button, buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot } from '@/components/ui/input-otp'
import { Spinner } from '@/components/ui/spinner'
import { callbackDestination } from '@/lib/auth/callback-url'
import { getRoute } from '@/lib/routing/routes'
import { hostOf } from '@/lib/submissions/contract'
import {
  CODE_ATTEMPTS,
  CODE_LENGTH,
  CODE_LIFETIME_MINUTES,
  CODE_LIFETIME_SECONDS,
  codeDigits,
  formatCountdown,
  formatWait,
  RESEND_COOLDOWN_SECONDS,
  readCodeText,
  requestCode,
  signOut,
  verifyCode
} from './sign-in-api'

/**
 * `/login`: the email-code sign-in from the #70 mockups (screen 1, shadcn login-01: Card +
 * Field). One form signs people up and in: email, then the emailed code, then a short
 * signed-in screen that returns to `callbackPath`.
 */

const REDIRECT_DELAY_MS = 1500
const DIGITS_ONLY = '^\\d+$'

type Notice =
  | { kind: 'limited'; until: number }
  | { kind: 'unavailable' }
  | { kind: 'failed' }
  | null

type CodeError =
  /** `attemptsLeft` is null when a resend may have replaced the code, so the count is unknown. */
  | { kind: 'wrong'; attemptsLeft: number | null }
  | { kind: 'expired' }
  | { kind: 'attempts' }
  | { kind: 'limited'; until: number }
  | { kind: 'failed' }
  | null

/**
 * The code step. `wrongGuesses` counts misses against the code the browser surely holds. After a
 * resend that may or may not have sent a new code (a per-email limit answers like a sent one),
 * `uncertain` is set: `wrongGuesses` still counts the old code's misses and `guessesSinceResend`
 * the new code's, and only the server's TOO_MANY_ATTEMPTS ends the code (PR #76 review 2).
 */
type Step =
  | { kind: 'email' }
  | {
      guessesSinceResend: number
      kind: 'code'
      sentAt: number
      uncertain: boolean
      wrongGuesses: number
    }
  | { kind: 'done'; email: string }

function freshCode(): Step {
  return {
    guessesSinceResend: 0,
    kind: 'code',
    sentAt: Date.now(),
    uncertain: false,
    wrongGuesses: 0
  }
}

export interface LoginCardProps {
  callbackPath: string
  /** Set when the visitor is already signed in: the card opens on the signed-in screen. */
  signedInEmail?: string | null
}

export function LoginCard({ callbackPath, signedInEmail }: LoginCardProps) {
  const router = useRouter()
  const [step, setStep] = useState<Step>(
    signedInEmail ? { email: signedInEmail, kind: 'done' } : { kind: 'email' }
  )
  const [email, setEmail] = useState('')
  const [emailError, setEmailError] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice>(null)
  const [otp, setOtp] = useState('')
  const [codeError, setCodeError] = useState<CodeError>(null)
  const [pending, setPending] = useState(false)
  /** The last code the server rejected; it is never sent again (PR #76 review 2). */
  const [rejectedCode, setRejectedCode] = useState<string | null>(null)
  const codeInput = useRef<HTMLInputElement>(null)
  /** Set synchronously, so a paste and a keystroke in the same tick cannot both submit. */
  const verifying = useRef(false)
  /**
   * Set while `onInput` has already read the field's whole value, so input-otp's change for the
   * same event (which keeps the first six digits of anything) is dropped. React runs `onInput`
   * before `onChange` for one input event; a microtask clears it after both.
   */
  const inputRead = useRef(false)
  const now = useNow(step.kind !== 'done')

  const destination = callbackDestination(callbackPath)
  const draftName = useSubmitDraftName(callbackPath)

  useEffect(() => {
    if (step.kind !== 'done') return undefined
    const timer = window.setTimeout(() => window.location.assign(callbackPath), REDIRECT_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [step, callbackPath])

  async function sendCode(address: string): Promise<boolean> {
    const outcome = await requestCode(address)
    switch (outcome.kind) {
      case 'sent':
        return true
      case 'invalid-email':
        setEmailError('Enter a valid email address, like you@company.com.')
        setStep({ kind: 'email' })
        return false
      case 'limited':
        setNotice({ kind: 'limited', until: Date.now() + outcome.retryAfterSeconds * 1000 })
        return false
      case 'unavailable':
        setNotice({ kind: 'unavailable' })
        return false
      default:
        setNotice({ kind: 'failed' })
        return false
    }
  }

  async function onEmailSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const address = email.trim()
    if (!address) {
      setEmailError('Enter your email address.')
      return
    }
    setPending(true)
    setEmailError(null)
    setNotice(null)
    const sent = await sendCode(address)
    setPending(false)
    if (!sent) return
    setEmail(address)
    setOtp('')
    setRejectedCode(null)
    setCodeError(null)
    setStep(freshCode())
  }

  async function onResend() {
    setPending(true)
    setNotice(null)
    const sent = await sendCode(email)
    setPending(false)
    if (!sent) return
    setOtp('')
    setRejectedCode(null)
    setCodeError(null)
    const codeDead = codeError?.kind === 'expired' || codeError?.kind === 'attempts'
    if (step.kind !== 'code' || codeDead) {
      setStep(freshCode())
      return
    }
    // A per-email limit answers like a sent code, so the inbox may hold the old code or a new
    // one: keep the old code's misses (PR #76 review 1, finding 3) and count the new code's
    // separately, and let the server decide when the code is spent (review 2, finding 2).
    setStep({
      guessesSinceResend: 0,
      kind: 'code',
      sentAt: Date.now(),
      uncertain: true,
      wrongGuesses: step.wrongGuesses
    })
  }

  /** Every change to the code field ends here, already reduced to at most six digits. */
  function onCodeChange(value: string) {
    setOtp(value)
    if (value !== rejectedCode && codeError?.kind === 'wrong') setCodeError(null)
    // A full code that differs from the rejected one is sent at once, whether it was typed,
    // pasted, or autofilled (onComplete misses a replaced value).
    if (value.length === CODE_LENGTH && value !== rejectedCode) void onVerify(value)
  }

  /**
   * Pasted or inserted text, read by `readCodeText`: one standalone code ("Code: 719208",
   * "482 913") replaces whatever the slots hold and is sent at once; a fragment (" 482 ") goes in
   * at the caret; anything ambiguous (two codes, seven digits) changes nothing and sends nothing.
   */
  function onCodeText(text: string, input: HTMLInputElement) {
    const read = readCodeText(text)
    if (read.kind === 'code') {
      onCodeChange(read.code)
      return
    }
    if (read.kind === 'ignore' || !read.digits) return
    const start = input.selectionStart ?? otp.length
    const end = input.selectionEnd ?? start
    onCodeChange((otp.slice(0, start) + read.digits + otp.slice(end)).slice(0, CODE_LENGTH))
  }

  // Text typed or inserted in one go (a keyboard's clipboard suggestion, drag and drop) is read
  // like a paste. input-otp would drop it for its separators, or keep its first six digits.
  // A single typed character stays with input-otp. Native `beforeinput`: React's
  // `onBeforeInput` is not that event and cannot be cancelled.
  useEffect(() => {
    const input = codeInput.current
    if (!input) return undefined
    function onBeforeInput(event: InputEvent) {
      if (!input || !event.cancelable || event.inputType === 'insertFromPaste') return
      const text = event.data ?? event.dataTransfer?.getData('text/plain') ?? ''
      if (!text || (text.length === 1 && codeDigits(text) === text)) return
      event.preventDefault()
      onCodeText(text, input)
    }
    input.addEventListener('beforeinput', onBeforeInput)
    return () => input.removeEventListener('beforeinput', onBeforeInput)
  })

  async function onVerify(code: string) {
    if (step.kind !== 'code' || verifying.current || code.length !== CODE_LENGTH) return
    if (code === rejectedCode) return
    verifying.current = true
    setPending(true)
    setCodeError(null)
    const outcome = await verifyCode(email, code)
    verifying.current = false
    setPending(false)
    if (outcome.kind === 'signed-in') {
      setStep({ email: outcome.email, kind: 'done' })
      // Re-render the server parts (the header) as signed in.
      router.refresh()
      return
    }
    // The digits stay in the (red) slots, as in the mockup, selected so the next code typed
    // replaces them; editing them clears the error.
    window.requestAnimationFrame(() => {
      const input = codeInput.current
      if (!input || input.disabled) return
      input.focus()
      input.setSelectionRange(0, input.value.length)
    })
    if (outcome.kind === 'wrong') {
      setRejectedCode(code)
      const wrongGuesses = step.wrongGuesses + 1
      const guessesSinceResend = step.guessesSinceResend + 1
      setStep({ ...step, guessesSinceResend, wrongGuesses })
      if (Date.now() - step.sentAt >= CODE_LIFETIME_SECONDS * 1000) {
        setCodeError({ kind: 'expired' })
      } else if (!step.uncertain) {
        // The browser surely holds this code, so the count is exact.
        setCodeError(
          wrongGuesses >= CODE_ATTEMPTS
            ? { kind: 'attempts' }
            : { attemptsLeft: CODE_ATTEMPTS - wrongGuesses, kind: 'wrong' }
        )
      } else if (guessesSinceResend >= CODE_ATTEMPTS) {
        // Spent whichever code the inbox holds.
        setCodeError({ kind: 'attempts' })
      } else {
        // Either code may be in the inbox: the server's TOO_MANY_ATTEMPTS decides when it is
        // spent, and the copy gives no count it cannot know.
        setCodeError({ attemptsLeft: null, kind: 'wrong' })
      }
      return
    }
    if (outcome.kind === 'limited') {
      setCodeError({ kind: 'limited', until: Date.now() + outcome.retryAfterSeconds * 1000 })
      return
    }
    setCodeError(
      outcome.kind === 'expired' || outcome.kind === 'attempts'
        ? { kind: outcome.kind }
        : { kind: 'failed' }
    )
  }

  async function onSignOut() {
    setPending(true)
    await signOut()
    window.location.assign(`${getRoute('login')}?callbackUrl=${encodeURIComponent(callbackPath)}`)
  }

  const limitedSeconds = notice?.kind === 'limited' ? (notice.until - now) / 1000 : 0
  const limitActive = notice?.kind === 'limited' && limitedSeconds > 0

  if (step.kind === 'done') {
    return (
      <LoginLayout>
        <CardHeader>
          <CardTitle className="text-xl">
            <h1>You’re signed in</h1>
          </CardTitle>
          <CardDescription>
            Signed in as <b className="font-medium text-foreground">{step.email}</b>.{' '}
            {draftName
              ? 'Taking you back to Submit, where your draft is waiting.'
              : destination.sentence}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner />
              Redirecting…
            </div>
            <Field>
              <Link href={callbackPath} className={buttonVariants({ className: 'w-full' })}>
                {destination.button}
                <ArrowRight />
              </Link>
              <FieldDescription className="text-center">
                Not you?{' '}
                <button
                  type="button"
                  className="underline underline-offset-4"
                  disabled={pending}
                  onClick={onSignOut}
                >
                  Sign out
                </button>
              </FieldDescription>
            </Field>
          </FieldGroup>
        </CardContent>
      </LoginLayout>
    )
  }

  if (step.kind === 'code') {
    // `now` ticks once a second and can trail `sentAt`; clamp so the countdown starts at 1:00.
    const resendIn = Math.min(
      RESEND_COOLDOWN_SECONDS,
      RESEND_COOLDOWN_SECONDS - Math.max(0, now - step.sentAt) / 1000
    )
    const codeDead = codeError?.kind === 'expired' || codeError?.kind === 'attempts'
    const guessLimitSeconds = codeError?.kind === 'limited' ? (codeError.until - now) / 1000 : 0
    const message = codeErrorMessage(codeError, guessLimitSeconds)
    return (
      <LoginLayout>
        <CardHeader>
          <CardTitle className="text-xl">
            <h1>Check your email</h1>
          </CardTitle>
          <CardDescription>
            If <b className="font-medium text-foreground">{email}</b> is a valid address, a{' '}
            {CODE_LENGTH}-digit code is on its way. It expires in {CODE_LIFETIME_MINUTES} minutes.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={event => {
              event.preventDefault()
              void onVerify(otp)
            }}
          >
            <FieldGroup>
              <Field data-invalid={message ? true : undefined}>
                <FieldLabel htmlFor="code">Code</FieldLabel>
                <InputOTP
                  ref={codeInput}
                  id="code"
                  autoFocus
                  autoComplete="one-time-code"
                  disabled={pending || codeDead}
                  inputMode="numeric"
                  maxLength={CODE_LENGTH}
                  aria-invalid={message ? true : undefined}
                  aria-describedby={message ? 'code-error' : 'code-description'}
                  pattern={DIGITS_ONLY}
                  // Never reached while onPasteCapture reads every paste; if it were, it keeps
                  // only a fragment's digits, never the first six digits of a sentence.
                  pasteTransformer={text => {
                    const read = readCodeText(text)
                    return read.kind === 'digits' ? read.digits : ''
                  }}
                  value={otp}
                  onChange={value => {
                    if (!inputRead.current) onCodeChange(value)
                  }}
                  onPasteCapture={event => {
                    // Every paste is read here, before input-otp's own paste handling.
                    event.preventDefault()
                    event.stopPropagation()
                    onCodeText(event.clipboardData.getData('text/plain'), event.currentTarget)
                  }}
                  onInput={event => {
                    // Autofill and password managers set the whole value at once, past the
                    // digits-only pattern and the six-character limit: read it like pasted
                    // text, so seven digits or a spaced code are never cut to their first six.
                    // Anything ambiguous is dropped, and React restores the previous value.
                    const value = event.currentTarget.value
                    if (codeDigits(value) === value && value.length <= CODE_LENGTH) return
                    inputRead.current = true
                    queueMicrotask(() => {
                      inputRead.current = false
                    })
                    const read = readCodeText(value)
                    if (read.kind === 'code') onCodeChange(read.code)
                    else if (read.kind === 'digits') onCodeChange(read.digits)
                  }}
                >
                  <InputOTPGroup>
                    {[0, 1, 2].map(index => (
                      <InputOTPSlot
                        key={index}
                        index={index}
                        aria-invalid={message ? true : undefined}
                        className="h-10 w-10 text-base"
                      />
                    ))}
                  </InputOTPGroup>
                  <InputOTPSeparator className="text-muted-foreground [&>svg]:size-4" />
                  <InputOTPGroup>
                    {[3, 4, 5].map(index => (
                      <InputOTPSlot
                        key={index}
                        index={index}
                        aria-invalid={message ? true : undefined}
                        className="h-10 w-10 text-base"
                      />
                    ))}
                  </InputOTPGroup>
                </InputOTP>
                {message ? (
                  <FieldError id="code-error">{message}</FieldError>
                ) : (
                  <FieldDescription id="code-description">
                    From SERP Directory &lt;noreply@mail.serp.co&gt;. Check spam if it isn’t there
                    in a minute.
                  </FieldDescription>
                )}
              </Field>
              <LoginNotice notice={notice} seconds={limitedSeconds} />
              <Field>
                {codeDead ? (
                  <Button
                    type="button"
                    className="w-full"
                    disabled={pending || limitActive}
                    onClick={onResend}
                  >
                    {pending ? <Spinner /> : null}
                    Send a new code
                  </Button>
                ) : (
                  <Button
                    type="submit"
                    className="w-full"
                    disabled={
                      pending ||
                      otp.length !== CODE_LENGTH ||
                      otp === rejectedCode ||
                      guessLimitSeconds > 0
                    }
                  >
                    {pending ? <Spinner /> : null}
                    Verify
                  </Button>
                )}
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  disabled={pending}
                  onClick={() => {
                    setNotice(null)
                    setCodeError(null)
                    setStep({ kind: 'email' })
                  }}
                >
                  Use a different email
                </Button>
                <FieldDescription className="text-center">
                  Didn’t get it?{' '}
                  {resendIn > 0 && !codeError ? (
                    <>
                      Resend in <span className="tabular-nums">{formatCountdown(resendIn)}</span>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="underline underline-offset-4"
                      disabled={pending || limitActive}
                      onClick={onResend}
                    >
                      Send a new code
                    </button>
                  )}
                </FieldDescription>
              </Field>
            </FieldGroup>
          </form>
        </CardContent>
      </LoginLayout>
    )
  }

  return (
    <LoginLayout>
      <CardHeader>
        <CardTitle className="text-xl">
          <h1>Sign up or sign in</h1>
        </CardTitle>
        <CardDescription>
          Enter your email and we’ll send you a {CODE_LENGTH}-digit code. New to SERP? The same code
          creates your account.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form noValidate onSubmit={onEmailSubmit}>
          <FieldGroup>
            {draftName ? (
              <Alert className="bg-card text-card-foreground">
                <Info aria-hidden="true" />
                <AlertTitle>Your {draftName} draft is saved</AlertTitle>
                <AlertDescription>Sign in to finish submitting it.</AlertDescription>
              </Alert>
            ) : null}
            <Field data-invalid={emailError ? true : undefined}>
              <FieldLabel htmlFor="email">Email</FieldLabel>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                autoFocus
                placeholder="you@company.com"
                required
                value={email}
                aria-invalid={emailError ? true : undefined}
                aria-describedby={emailError ? 'email-error' : undefined}
                onChange={event => {
                  setEmail(event.target.value)
                  setEmailError(null)
                }}
              />
              {emailError ? <FieldError id="email-error">{emailError}</FieldError> : null}
            </Field>
            <LoginNotice notice={notice} seconds={limitedSeconds} />
            <Field>
              <Button type="submit" className="w-full" disabled={pending || limitActive}>
                {pending ? <Spinner /> : null}
                Email me a code
              </Button>
              <FieldDescription className="text-center">
                By continuing you agree to the{' '}
                <Link href={getRoute('terms')} className="underline underline-offset-4">
                  Terms of Service
                </Link>{' '}
                and{' '}
                <Link href={getRoute('privacy')} className="underline underline-offset-4">
                  Privacy Policy
                </Link>
                .
              </FieldDescription>
            </Field>
          </FieldGroup>
        </form>
      </CardContent>
    </LoginLayout>
  )
}

/**
 * The product name of the `/submit` draft kept in this browser (#63), when the visitor is
 * signing in on the way back to Submit: the card then says the draft is saved and waiting.
 * Read after mount, since the server cannot see browser storage.
 */
function useSubmitDraftName(callbackPath: string): string | null {
  const [name, setName] = useState<string | null>(null)
  useEffect(() => {
    if (!/^\/submit(?:\/|\?|$)/u.test(callbackPath)) return
    const draft = readLocalDraft(null)
    const label = draft?.name.trim() || (draft?.website ? hostOf(draft.website) : '')
    setName(label || null)
  }, [callbackPath])
  return name
}

/** login-01's page layout: a centred column, max-w-sm, holding the card. */
function LoginLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex w-full items-center justify-center p-6 md:p-10">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <Card>{children}</Card>
      </div>
    </div>
  )
}

function LoginNotice({ notice, seconds }: { notice: Notice; seconds: number }) {
  if (notice?.kind === 'limited' && seconds > 0) {
    return (
      <Alert className="border-warning/40 bg-card text-warning">
        <Clock />
        <AlertTitle>Too many code requests</AlertTitle>
        <AlertDescription>
          <p>Try again in {formatWait(seconds)}, or use the most recent code we sent.</p>
        </AlertDescription>
      </Alert>
    )
  }
  if (notice?.kind === 'unavailable') {
    return (
      <Alert variant="destructive">
        <CircleX />
        <AlertTitle>Sign-in codes aren’t available right now</AlertTitle>
        <AlertDescription>
          <p>We can’t send sign-in codes from this site at the moment. Please try again later.</p>
        </AlertDescription>
      </Alert>
    )
  }
  if (notice?.kind === 'failed') {
    return (
      <Alert variant="destructive">
        <CircleX />
        <AlertTitle>Something went wrong</AlertTitle>
        <AlertDescription>
          <p>We couldn’t reach SERP. Check your connection and try again.</p>
        </AlertDescription>
      </Alert>
    )
  }
  return null
}

function codeErrorMessage(error: CodeError, limitSeconds: number): string | null {
  switch (error?.kind) {
    case 'wrong':
      return error.attemptsLeft === null
        ? 'That code isn’t right. Check the most recent email and try again.'
        : `That code isn’t right. Check the most recent email and try again. ${error.attemptsLeft} ${error.attemptsLeft === 1 ? 'attempt' : 'attempts'} left.`
    case 'expired':
      return `This code has expired. Codes work for ${CODE_LIFETIME_MINUTES} minutes.`
    case 'attempts':
      return 'Too many incorrect codes. Request a new code to try again.'
    case 'limited':
      return limitSeconds > 0
        ? `Too many attempts from this network. Try again in ${formatWait(limitSeconds)}.`
        : null
    case 'failed':
      return 'We couldn’t check that code. Check your connection and try again.'
    default:
      return null
  }
}

/** The current time, ticking every second while `active`, for the countdowns. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return undefined
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [active])
  return now
}

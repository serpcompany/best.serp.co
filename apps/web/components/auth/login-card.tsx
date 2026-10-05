'use client'

import { Alert, AlertDescription, AlertTitle } from '@serpdirectory/design-system/alert'
import { Button } from '@serpdirectory/design-system/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@serpdirectory/design-system/card'
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel
} from '@serpdirectory/design-system/field'
import { Input } from '@serpdirectory/design-system/input'
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSeparator,
  InputOTPSlot
} from '@serpdirectory/design-system/input-otp'
import { Spinner } from '@serpdirectory/design-system/spinner'
import { getRoute } from '@serpdirectory/web-core/routes'
import { ArrowRight, CircleX, Clock } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { type FormEvent, type ReactNode, useEffect, useState } from 'react'
import { callbackDestination } from '@/lib/auth/callback-url'
import {
  CODE_ATTEMPTS,
  CODE_LENGTH,
  CODE_LIFETIME_SECONDS,
  formatCountdown,
  formatWait,
  RESEND_COOLDOWN_SECONDS,
  requestCode,
  signOut,
  verifyCode
} from './sign-in-api'

/**
 * `/login`: the email-code sign-in from the #70 mockups (screen 1, shadcn login-01: Card +
 * Field). One form signs people up and in: email, then the 6-digit code, then a short
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
  | { kind: 'wrong'; attemptsLeft: number }
  | { kind: 'expired' }
  | { kind: 'attempts' }
  | { kind: 'limited'; until: number }
  | { kind: 'failed' }
  | null

type Step =
  | { kind: 'email' }
  | { kind: 'code'; sentAt: number; wrongGuesses: number }
  | { kind: 'done'; email: string }

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
  const now = useNow(step.kind !== 'done')

  const destination = callbackDestination(callbackPath)

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
    setCodeError(null)
    setStep({ kind: 'code', sentAt: Date.now(), wrongGuesses: 0 })
  }

  async function onResend() {
    setPending(true)
    setNotice(null)
    const sent = await sendCode(email)
    setPending(false)
    if (!sent) return
    setOtp('')
    setCodeError(null)
    setStep({ kind: 'code', sentAt: Date.now(), wrongGuesses: 0 })
  }

  async function onVerify(code: string) {
    if (step.kind !== 'code' || pending || code.length !== CODE_LENGTH) return
    setPending(true)
    setCodeError(null)
    const outcome = await verifyCode(email, code)
    setPending(false)
    if (outcome.kind === 'signed-in') {
      setStep({ email: outcome.email, kind: 'done' })
      // Re-render the server parts (the header) as signed in.
      router.refresh()
      return
    }
    setOtp('')
    if (outcome.kind === 'wrong') {
      const wrongGuesses = step.wrongGuesses + 1
      setStep({ ...step, wrongGuesses })
      if (Date.now() - step.sentAt >= CODE_LIFETIME_SECONDS * 1000) {
        setCodeError({ kind: 'expired' })
      } else if (wrongGuesses >= CODE_ATTEMPTS) {
        setCodeError({ kind: 'attempts' })
      } else {
        setCodeError({ attemptsLeft: CODE_ATTEMPTS - wrongGuesses, kind: 'wrong' })
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
          <CardTitle role="heading" aria-level={1} className="text-xl">
            You’re signed in
          </CardTitle>
          <CardDescription>
            Signed in as <b className="font-medium text-foreground">{step.email}</b>.{' '}
            {destination.sentence}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner />
              Redirecting…
            </div>
            <Field>
              <Button asChild className="w-full">
                <Link href={callbackPath}>
                  {destination.button}
                  <ArrowRight />
                </Link>
              </Button>
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
    const resendIn = RESEND_COOLDOWN_SECONDS - (now - step.sentAt) / 1000
    const codeDead = codeError?.kind === 'expired' || codeError?.kind === 'attempts'
    const guessLimitSeconds = codeError?.kind === 'limited' ? (codeError.until - now) / 1000 : 0
    const message = codeErrorMessage(codeError, guessLimitSeconds)
    return (
      <LoginLayout>
        <CardHeader>
          <CardTitle role="heading" aria-level={1} className="text-xl">
            Check your email
          </CardTitle>
          <CardDescription>
            If <b className="font-medium text-foreground">{email}</b> is a valid address, a 6-digit
            code is on its way. It expires in 10 minutes.
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
                  id="code"
                  autoFocus
                  autoComplete="one-time-code"
                  disabled={pending || codeDead}
                  inputMode="numeric"
                  maxLength={CODE_LENGTH}
                  pattern={DIGITS_ONLY}
                  value={otp}
                  onChange={value => {
                    setOtp(value)
                    if (codeError?.kind === 'wrong') setCodeError(null)
                  }}
                  onComplete={value => void onVerify(value)}
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
                  <InputOTPSeparator className="text-muted-foreground" />
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
                  <FieldError>{message}</FieldError>
                ) : (
                  <FieldDescription>
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
                    disabled={pending || otp.length !== CODE_LENGTH || guessLimitSeconds > 0}
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
        <CardTitle role="heading" aria-level={1} className="text-xl">
          Sign up or sign in
        </CardTitle>
        <CardDescription>
          Enter your email and we’ll send you a 6-digit code. New to SERP? The same code creates
          your account.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form noValidate onSubmit={onEmailSubmit}>
          <FieldGroup>
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
                onChange={event => {
                  setEmail(event.target.value)
                  setEmailError(null)
                }}
              />
              {emailError ? <FieldError>{emailError}</FieldError> : null}
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
      <Alert className="border-amber-500/40 bg-card text-amber-700 dark:text-amber-400">
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
      return `That code isn’t right. Check the most recent email and try again. ${error.attemptsLeft} ${error.attemptsLeft === 1 ? 'attempt' : 'attempts'} left.`
    case 'expired':
      return 'This code has expired. Codes work for 10 minutes.'
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

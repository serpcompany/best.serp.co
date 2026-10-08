'use client'

import { Alert, AlertDescription, AlertTitle } from '@serpdirectory/design-system/alert'
import { Button } from '@serpdirectory/design-system/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@serpdirectory/design-system/dialog'
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle
} from '@serpdirectory/design-system/drawer'
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldTitle
} from '@serpdirectory/design-system/field'
import { Input } from '@serpdirectory/design-system/input'
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSeparator,
  InputOTPSlot
} from '@serpdirectory/design-system/input-otp'
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle
} from '@serpdirectory/design-system/item'
import { Progress } from '@serpdirectory/design-system/progress'
import { RadioGroup, RadioGroupItem } from '@serpdirectory/design-system/radio-group'
import { Separator } from '@serpdirectory/design-system/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from '@serpdirectory/design-system/tooltip'
import { useIsMobile } from '@serpdirectory/design-system/use-mobile'
import { buildFeaturedOnBadgeEmbedHtml } from '@serpdirectory/web-core/website/featured-on-badge-embed-panel'
import { ArrowRight, BadgeCheck, Copy, MessageSquare, ShieldCheck } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { formatWait } from '@/components/auth/sign-in-api'
import { type BadgeOutcome, badgeCheckResultAlert } from '@/components/submit/badge-step'
import { call } from '@/components/submit/submit-api'

/**
 * Claiming a listing (serpcompany/best.serp.co#67, #70 screens 8 and 9a): the sidebar's "Claim
 * this listing" link opens a dialog (a drawer on mobile) that walks through the method, the
 * work email, its code, then the badge (or the payment, #68, offered only while orders are on).
 * Every string is the approved #70 copy (`docs/mockups/submissions/COPY.md`). The API decides
 * everything (`/api/claims`); this component only shows its answers.
 */

const CODE_LENGTH = 6
const BADGE_CHECKS = 10
const BADGE_COOLDOWN_SECONDS = 30

interface ClaimView {
  attemptsLeft: number
  checksLeft: number
  codeExpiresAt: string
  /** Until when the confirmed address can finish the claim. */
  confirmedUntil: string | null
  email: string
  id: string
  lockedUntil: string | null
  method: 'badge' | 'paid'
  resendAvailableAt: string
  status: 'cancelled' | 'code_sent' | 'completed' | 'email_verified'
}

interface ClaimTarget {
  domain: string
  listing: { name: string; slug: string }
  openClaim: ClaimView | null
  paid: boolean
  productUrl: string
}

interface ApiFailure {
  attemptsLeft?: number
  code: string
  contactPath?: string
  retryAfterSeconds?: number
  /** `already_owned` by the caller. */
  self?: boolean
}

type Step =
  | 'badge'
  | 'code'
  | 'done'
  | 'email'
  | 'loading'
  | 'method'
  /** The caller already owns the listing. */
  | 'mine'
  | 'owned'
  | 'payment'
  | 'unclaimable'

export interface ClaimListingProps {
  badge: { badgeUrl: string; listingUrl: string; previewUrl: string; siteName: string }
  copy: { badgeCardNote: string | null; keepTheBadge: string | null }
  listing: { name: string; slug: string }
  priceCents: number
}

/** Webmail providers by registrable domain, for "Gmail addresses can’t confirm…". */
const PROVIDERS: Record<string, string> = {
  'gmail.com': 'Gmail',
  'googlemail.com': 'Gmail',
  'hotmail.com': 'Hotmail',
  'icloud.com': 'iCloud',
  'live.com': 'Outlook',
  'me.com': 'iCloud',
  'msn.com': 'Outlook',
  'outlook.com': 'Outlook',
  'pm.me': 'Proton',
  'proton.me': 'Proton',
  'protonmail.com': 'Proton',
  'yahoo.com': 'Yahoo'
}

function domainOf(email: string): string {
  return email.trim().toLowerCase().split('@')[1] ?? ''
}

function providerName(email: string): string {
  const domain = domainOf(email)
  if (PROVIDERS[domain]) return PROVIDERS[domain]
  const label = domain.split('.')[0] ?? domain
  return label ? `${label[0]?.toUpperCase()}${label.slice(1)}` : 'Personal'
}

function formatCountdown(seconds: number): string {
  const whole = Math.max(0, Math.ceil(seconds))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

function usd(cents: number, withCents: boolean): string {
  return `$${withCents ? (cents / 100).toFixed(2) : Math.round(cents / 100)}`
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return undefined
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [active])
  return now
}

function StepHeader({ label, step }: { label: string; step: number }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{label}</span>
        <span>Step {step} of 4</span>
      </div>
      <Progress value={step * 25} aria-label={`${label}, step ${step} of 4`} />
    </div>
  )
}

export function ClaimListing({ badge, copy, listing, priceCents }: ClaimListingProps) {
  const router = useRouter()
  const isMobile = useIsMobile()
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState<Step>('loading')
  const [target, setTarget] = useState<ClaimTarget | null>(null)
  const [claim, setClaim] = useState<ClaimView | null>(null)
  const [method, setMethod] = useState<'badge' | 'paid'>('badge')
  const [email, setEmail] = useState('')
  const [emailError, setEmailError] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [codeError, setCodeError] = useState<'attempts' | 'expired' | 'invalid' | 'rate' | null>(
    null
  )
  /** "Try again in …" for a send the hourly caps refused. */
  const [rateWait, setRateWait] = useState('')
  /** The visitor owns the listing now: the claim link goes without waiting for the page. */
  const [owner, setOwner] = useState(false)
  const [contactPath, setContactPath] = useState('/contact/')
  const [outcome, setOutcome] = useState<BadgeOutcome>(null)
  const [badgeWaitUntil, setBadgeWaitUntil] = useState(0)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const inFlight = useRef(false)
  const name = listing.name
  const domain = target?.domain ?? ''
  const embed = buildFeaturedOnBadgeEmbedHtml({
    badgeUrl: badge.badgeUrl,
    listingUrl: badge.listingUrl,
    siteName: badge.siteName
  })

  const resendAt = claim ? Date.parse(claim.resendAvailableAt) : 0
  const now = useNow(open && (resendAt > Date.now() || badgeWaitUntil > Date.now()))
  const resendSeconds = Math.max(0, (resendAt - now) / 1000)
  // Clamped: the check time is the server's, so a slow answer could read 0:31.
  const badgeWaitSeconds = Math.min(
    BADGE_COOLDOWN_SECONDS,
    Math.max(0, (badgeWaitUntil - now) / 1000)
  )

  const signIn = useCallback(() => {
    const back = `/products/${listing.slug}/#claim`
    window.location.assign(`/login/?callbackUrl=${encodeURIComponent(back)}`)
  }, [listing.slug])

  /** Where an answer that isn't a step's own error sends the dialog. */
  const elsewhere = useCallback(
    (status: number, error: ApiFailure): boolean => {
      if (status === 401) {
        signIn()
        return true
      }
      if (error.code === 'already_owned' && error.self) {
        setOwner(true)
        setStep('mine')
        return true
      }
      if (error.code === 'already_owned') {
        setContactPath(error.contactPath ?? '/contact/')
        setStep('owned')
        return true
      }
      if (['blocked', 'no_product_domain', 'not_found', 'review_required'].includes(error.code)) {
        setContactPath(error.contactPath ?? '/contact/')
        setStep('unclaimable')
        return true
      }
      return false
    },
    [signIn]
  )

  const resume = useCallback((found: ClaimTarget) => {
    setTarget(found)
    const resumed = found.openClaim
    setClaim(resumed)
    setMethod(resumed?.method === 'paid' && found.paid ? 'paid' : 'badge')
    if (resumed?.status === 'code_sent') {
      setEmail(resumed.email)
      setCodeError(
        resumed.lockedUntil && Date.parse(resumed.lockedUntil) > Date.now() ? 'attempts' : null
      )
      setStep('code')
    } else if (
      resumed?.status === 'email_verified' &&
      resumed.confirmedUntil &&
      Date.parse(resumed.confirmedUntil) <= Date.now()
    ) {
      // A confirmation lasts 24 hours: past that, the address is confirmed again with a new code.
      setEmail(resumed.email)
      setCodeError('expired')
      setStep('code')
    } else if (resumed?.status === 'email_verified') {
      setEmail(resumed.email)
      setStep(resumed.method === 'paid' ? 'payment' : 'badge')
    } else {
      setStep('method')
    }
  }, [])

  const load = useCallback(async () => {
    setStep('loading')
    const response = await call<{ target: ClaimTarget }>(
      `/api/claims?listing=${encodeURIComponent(listing.slug)}`,
      { method: 'GET' }
    )
    if (response.ok) resume(response.data.target)
    else if (!elsewhere(response.status, response.error as ApiFailure)) {
      setContactPath('/contact/')
      setStep('unclaimable')
    }
  }, [elsewhere, listing.slug, resume])

  // The page refreshes only once the dialog closes: an owned listing no longer renders the claim
  // link, so refreshing while the success (or already-owned) answer shows would unmount it.
  const changeOpen = (next: boolean) => {
    setOpen(next)
    if (!next && (step === 'done' || step === 'mine' || step === 'owned')) router.refresh()
  }

  const openDialog = useCallback(() => {
    setOpen(true)
    void load()
  }, [load])

  // After signing in, the login page brings the visitor back to `#claim`.
  useEffect(() => {
    if (window.location.hash === '#claim') openDialog()
  }, [openDialog])

  async function sendCode() {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setEmailError(null)
    const response = await call<{ claim: ClaimView }>('/api/claims', {
      body: JSON.stringify({ email, listing: listing.slug, method }),
      method: 'POST'
    })
    inFlight.current = false
    setBusy(false)
    if (response.ok) {
      setClaim(response.data.claim)
      setCode('')
      setCodeError(null)
      setStep('code')
      return
    }
    const error = response.error as ApiFailure
    if (elsewhere(response.status, error)) return
    if (error.code === 'webmail') {
      setEmailError(
        `${providerName(email)} addresses can’t confirm you work at ${name}. Use an address at ${domain}.`
      )
    } else if (error.code === 'invalid_email') {
      setEmailError('Enter a valid email address, like you@company.com.')
    } else if (error.code === 'domain_mismatch') {
      setEmailError(
        `That address is at ${domainOf(email) || email}. Use an email at ${domain} (subdomains like team.${domain} work too).`
      )
    } else if (
      error.code === 'cooldown' &&
      step === 'email' &&
      claim?.status === 'code_sent' &&
      claim.email === email.trim().toLowerCase()
    ) {
      // The code sent a moment ago to this address still works.
      setStep('code')
    } else if (error.code === 'cooldown') {
      const wait = formatWait(error.retryAfterSeconds ?? 60)
      if (step === 'code') {
        setRateWait(wait)
        setCodeError('rate')
      } else {
        setEmailError(`Too many code requests. Try again in ${wait}.`)
      }
    } else if (error.code === 'too_many_attempts') {
      // The claim is locked: back to the code step as it stands.
      await load()
    }
  }

  async function verifyCode(value: string) {
    if (inFlight.current || !claim || value.length !== CODE_LENGTH) return
    inFlight.current = true
    setBusy(true)
    const response = await call<{ claim: ClaimView }>(`/api/claims/${claim.id}/confirm`, {
      body: JSON.stringify({ code: value }),
      method: 'POST'
    })
    inFlight.current = false
    setBusy(false)
    if (response.ok) {
      setClaim(response.data.claim)
      setCodeError(null)
      setStep(response.data.claim.method === 'paid' ? 'payment' : 'badge')
      return
    }
    const error = response.error as ApiFailure
    if (elsewhere(response.status, error)) return
    setCodeError(
      error.code === 'code_expired'
        ? 'expired'
        : error.code === 'too_many_attempts'
          ? 'attempts'
          : 'invalid'
    )
  }

  async function verifyBadge() {
    if (inFlight.current || !claim) return
    inFlight.current = true
    setBusy(true)
    const response = await call<{ claim: ClaimView; result: BadgeOutcome & { ok?: boolean } }>(
      `/api/claims/${claim.id}/verify-badge`,
      { method: 'POST' }
    )
    inFlight.current = false
    setBusy(false)
    if (response.ok) {
      setClaim(response.data.claim)
      if (response.data.claim.status === 'completed') {
        setOwner(true)
        setStep('done')
        return
      }
      setOutcome(response.data.result)
      setBadgeWaitUntil(Date.now() + BADGE_COOLDOWN_SECONDS * 1000)
      return
    }
    const error = response.error as ApiFailure
    if (elsewhere(response.status, error)) return
    if (error.code === 'confirmation_expired') {
      // 24 hours after the address was confirmed: confirm it again with a new code.
      setEmail(claim.email)
      setCode('')
      setCodeError('expired')
      setStep('code')
    } else if (error.code === 'cooldown') {
      setBadgeWaitUntil(Date.now() + (error.retryAfterSeconds ?? BADGE_COOLDOWN_SECONDS) * 1000)
    } else if (error.code === 'checks_used') {
      setClaim(current => (current ? { ...current, checksLeft: 0 } : current))
    } else {
      await load()
    }
  }

  async function copyEmbed() {
    try {
      await navigator.clipboard.writeText(embed)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  const title =
    step === 'done'
      ? `You now manage ${name}`
      : step === 'mine'
        ? 'You manage this listing'
        : step === 'owned'
          ? `${name} already has an owner`
          : `Claim ${name}`
  const description =
    step === 'done' || step === 'mine'
      ? 'It’s in your account. Edits you make are reviewed before they go live.'
      : step === 'owned'
        ? 'Someone has already verified that they own this listing.'
        : `Prove you work at ${name} to manage this listing.`

  let body: ReactNode = null
  let footer: ReactNode = null
  const back = (to: Step) => (
    <Button variant="outline" onClick={() => setStep(to)} disabled={busy}>
      Back
    </Button>
  )

  if (step === 'loading') {
    body = <div className="h-24" aria-busy="true" />
  } else if (step === 'method') {
    body = (
      <div className="flex flex-col gap-4">
        <StepHeader label="Method" step={1} />
        <RadioGroup
          value={method}
          onValueChange={value => setMethod(value === 'paid' ? 'paid' : 'badge')}
          className="grid gap-3"
        >
          <FieldLabel htmlFor="claim-method-badge">
            <Field orientation="horizontal">
              <RadioGroupItem value="badge" id="claim-method-badge" />
              <FieldContent>
                <FieldTitle>Install the badge (free)</FieldTitle>
                <FieldDescription>
                  {`Add our badge to ${domain} with a dofollow link to this listing.`}
                  {copy.badgeCardNote ? ` ${copy.badgeCardNote}` : ''}
                </FieldDescription>
              </FieldContent>
            </Field>
          </FieldLabel>
          {target?.paid ? (
            <FieldLabel htmlFor="claim-method-paid">
              <Field orientation="horizontal">
                <RadioGroupItem value="paid" id="claim-method-paid" />
                <FieldContent>
                  <FieldTitle>{`Skip the badge: ${usd(priceCents, false)} one-off`}</FieldTitle>
                  <FieldDescription>
                    No badge needed, and ownership doesn’t depend on one.
                  </FieldDescription>
                </FieldContent>
              </Field>
            </FieldLabel>
          ) : null}
        </RadioGroup>
        <FieldDescription>
          Either way, you’ll confirm an email address at{' '}
          <b className="font-medium text-foreground">{domain}</b>.
        </FieldDescription>
      </div>
    )
    footer = (
      <>
        <Button variant="outline" onClick={() => changeOpen(false)}>
          Cancel
        </Button>
        <Button onClick={() => setStep('email')}>Continue</Button>
      </>
    )
  } else if (step === 'email') {
    body = (
      <form
        id="claim-email"
        className="flex flex-col gap-6"
        onSubmit={event => {
          event.preventDefault()
          void sendCode()
        }}
      >
        <StepHeader label="Work email" step={2} />
        <Field data-invalid={emailError ? true : undefined}>
          <FieldLabel htmlFor="claim-email-input">{`Your email at ${domain}`}</FieldLabel>
          <Input
            id="claim-email-input"
            type="email"
            autoComplete="email"
            required
            value={email}
            aria-invalid={emailError ? true : undefined}
            onChange={event => {
              setEmail(event.target.value)
              setEmailError(null)
            }}
          />
          {emailError ? (
            <FieldError>{emailError}</FieldError>
          ) : (
            <FieldDescription>
              We’ll send a 6-digit code. Personal addresses like Gmail or Outlook can’t be used.
            </FieldDescription>
          )}
        </Field>
      </form>
    )
    footer = (
      <>
        {back('method')}
        <Button type="submit" form="claim-email" disabled={busy}>
          Send code
        </Button>
      </>
    )
  } else if (step === 'code') {
    const invalid = codeError !== null
    body = (
      <div className="flex flex-col gap-6">
        <StepHeader label="Code" step={3} />
        <Field data-invalid={invalid ? true : undefined}>
          <FieldLabel htmlFor="claim-code">{`Code sent to ${claim?.email ?? email}`}</FieldLabel>
          <InputOTP
            id="claim-code"
            autoFocus
            autoComplete="one-time-code"
            inputMode="numeric"
            maxLength={CODE_LENGTH}
            pattern="^\d+$"
            disabled={busy || codeError === 'attempts'}
            aria-invalid={invalid ? true : undefined}
            value={code}
            onChange={value => {
              setCode(value)
              if (codeError === 'invalid' || codeError === 'rate') setCodeError(null)
              if (value.length === CODE_LENGTH && codeError !== 'expired') void verifyCode(value)
            }}
          >
            <InputOTPGroup>
              {[0, 1, 2].map(index => (
                <InputOTPSlot
                  key={index}
                  index={index}
                  aria-invalid={invalid ? true : undefined}
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
                  aria-invalid={invalid ? true : undefined}
                  className="h-10 w-10 text-base"
                />
              ))}
            </InputOTPGroup>
          </InputOTP>
          {codeError === 'expired' ? (
            <FieldError>This code has expired. Send a new one.</FieldError>
          ) : codeError === 'attempts' ? (
            <FieldError>
              Too many incorrect codes. Wait 15 minutes, then request a new code.
            </FieldError>
          ) : codeError === 'invalid' ? (
            <FieldError>That code isn’t right.</FieldError>
          ) : codeError === 'rate' ? (
            <FieldError>
              {`Too many code requests. Try again in ${rateWait}, or use the most recent code we sent.`}
            </FieldError>
          ) : (
            <FieldDescription>
              It expires in 10 minutes. Didn’t get it?{' '}
              {resendSeconds > 0 ? (
                <>
                  Resend in <span className="tabular-nums">{formatCountdown(resendSeconds)}</span>
                </>
              ) : (
                <Button
                  type="button"
                  variant="link"
                  className="h-auto p-0"
                  disabled={busy}
                  onClick={() => void sendCode()}
                >
                  Resend
                </Button>
              )}
            </FieldDescription>
          )}
        </Field>
      </div>
    )
    footer = (
      <>
        {back('email')}
        {codeError === 'expired' ? (
          <Button disabled={busy} onClick={() => void sendCode()}>
            Send a new code
          </Button>
        ) : (
          <Button
            disabled={busy || codeError === 'attempts' || code.length !== CODE_LENGTH}
            onClick={() => void verifyCode(code)}
          >
            Verify
          </Button>
        )}
      </>
    )
  } else if (step === 'badge') {
    const checksLeft = claim?.checksLeft ?? BADGE_CHECKS
    const site = target?.productUrl ?? ''
    body = (
      <div className="flex flex-col gap-4">
        <StepHeader label="Badge" step={4} />
        <p className="text-sm text-muted-foreground">
          {`Paste this into the HTML of ${site} and keep the link dofollow.`}
        </p>
        <img src={badge.previewUrl} alt="Featured on SERP" width={170} height={42} />
        <div className="w-full overflow-x-auto rounded-md border border-input px-3 py-2 font-mono text-[11px] leading-relaxed shadow-xs dark:bg-input/30">
          {/* A div, not a <pre>: the site's global <pre> style is a dark code block. */}
          <div className="whitespace-pre text-foreground">{embed}</div>
        </div>
        <div className="flex items-center justify-between gap-2">
          <Tooltip open={copied}>
            <TooltipTrigger asChild>
              <Button variant="outline" size="sm" onClick={() => void copyEmbed()}>
                <Copy />
                Copy code
              </Button>
            </TooltipTrigger>
            <TooltipContent>Copied to clipboard</TooltipContent>
          </Tooltip>
          <span className="text-xs text-muted-foreground">
            {checksLeft} of {BADGE_CHECKS} checks left
          </span>
        </div>
        {outcome
          ? badgeCheckResultAlert(outcome.code, outcome, {
              domain: (() => {
                try {
                  return new URL(site).host
                } catch {
                  return domain
                }
              })(),
              listingUrl: badge.listingUrl,
              site
            })
          : null}
      </div>
    )
    footer = (
      <>
        {back('method')}
        <Button
          disabled={busy || badgeWaitSeconds > 0 || checksLeft <= 0}
          onClick={() => void verifyBadge()}
        >
          <ShieldCheck />
          {badgeWaitSeconds > 0
            ? `Check again in ${formatCountdown(badgeWaitSeconds)}`
            : 'Verify badge and claim'}
        </Button>
      </>
    )
  } else if (step === 'payment') {
    body = (
      <div className="flex flex-col gap-4">
        <StepHeader label="Payment" step={4} />
        <Item variant="outline">
          <ItemContent>
            <ItemTitle>{`Paid claim: ${name}`}</ItemTitle>
            <ItemDescription>One-off payment, USD</ItemDescription>
          </ItemContent>
          <ItemActions>
            <span className="text-base font-semibold tabular-nums">{usd(priceCents, true)}</span>
          </ItemActions>
        </Item>
        <FieldDescription>
          {`${claim?.email ?? email} is confirmed. You become the owner as soon as the payment goes through.`}
        </FieldDescription>
      </div>
    )
    footer = (
      <>
        {back('method')}
        {/* The paid method only shows once orders are on (#68). A plain link: the route opens
            the payment provider's checkout and comes back to this dialog. */}
        <Button asChild disabled={!claim}>
          <a href={claim ? `/claims/${claim.id}/checkout/` : '#claim'}>
            {`Continue to payment: ${usd(priceCents, false)}`}
            <ArrowRight />
          </a>
        </Button>
      </>
    )
  } else if (step === 'done' || step === 'mine') {
    body =
      step === 'done' && copy.keepTheBadge ? (
        <Alert>
          <ShieldCheck aria-hidden="true" />
          <AlertTitle>{`Keep the badge on ${domain}`}</AlertTitle>
          <AlertDescription>{copy.keepTheBadge}</AlertDescription>
        </Alert>
      ) : null
    footer = (
      <>
        <Button asChild variant="outline">
          <Link href={`/account/listings/${listing.slug}/edit/`}>Edit listing</Link>
        </Button>
        <Button asChild>
          <Link href="/account/">Open account</Link>
        </Button>
      </>
    )
  } else if (step === 'owned') {
    body = (
      <FieldDescription>
        If you think that’s a mistake, message us. We’ll check with the current owner and can move
        the listing to you.
      </FieldDescription>
    )
    footer = (
      <>
        <Button variant="outline" onClick={() => changeOpen(false)}>
          Close
        </Button>
        <Button asChild>
          <Link href={contactPath}>
            <MessageSquare />
            Message us
          </Link>
        </Button>
      </>
    )
  } else {
    body = <FieldError>This URL can’t be claimed.</FieldError>
    footer = (
      <>
        <Button variant="outline" onClick={() => changeOpen(false)}>
          Close
        </Button>
        <Button asChild>
          <Link href={contactPath}>
            <MessageSquare />
            Message us
          </Link>
        </Button>
      </>
    )
  }

  const trigger = (
    <>
      <Separator className="bg-border/50" />
      <div className="flex flex-col gap-1">
        <p className="text-sm text-muted-foreground">{`Work at ${name}?`}</p>
        <Button
          variant="link"
          className="h-auto w-fit p-0 text-foreground"
          onClick={openDialog}
          data-testid="claim-listing"
        >
          <BadgeCheck />
          Claim this listing
        </Button>
      </div>
    </>
  )

  if (isMobile) {
    return (
      <>
        {owner ? null : trigger}
        <Drawer open={open} onOpenChange={changeOpen}>
          <DrawerContent>
            <DrawerHeader className="text-left">
              <DrawerTitle>{title}</DrawerTitle>
              <DrawerDescription>{description}</DrawerDescription>
            </DrawerHeader>
            <div className="min-w-0 overflow-y-auto px-4">{body}</div>
            <DrawerFooter>{footer}</DrawerFooter>
          </DrawerContent>
        </Drawer>
      </>
    )
  }
  return (
    <>
      {owner ? null : trigger}
      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogContent className="sm:max-w-lg [&>*]:min-w-0">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          {body}
          <DialogFooter>{footer}</DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

'use client'

import { Button } from '@serpdirectory/design-system/button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle
} from '@serpdirectory/design-system/card'
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle
} from '@serpdirectory/design-system/item'
import { Spinner } from '@serpdirectory/design-system/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@serpdirectory/design-system/tooltip'
import { buildFeaturedOnBadgeEmbedHtml } from '@serpdirectory/web-core/website/featured-on-badge-embed-panel'
import {
  ArrowRight,
  Check,
  Clock,
  Copy,
  Globe,
  MessageSquare,
  Plus,
  ShieldCheck
} from 'lucide-react'
import Link from 'next/link'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { featureCopy } from '@/lib/feature-copy'
import {
  checksLeft,
  checksPaused,
  hostOf,
  type SubmissionSummary,
  VERIFICATION_ATTEMPT_LIMIT,
  VERIFICATION_COOLDOWN_SECONDS,
  verificationInstant
} from '@/lib/submissions/contract'
import { verifyBadge } from './submit-api'
import { ProductLogo, StepProgress, ToneAlert } from './submit-ui'

/**
 * `/submit/<id>/badge/` (#70 screen 3): the two badge snippets, then "Verify badge". A check
 * loads the website and looks for the badge with a dofollow link to the future listing. At
 * most ten conclusive checks, one every 30 seconds; connection problems never use one up. A
 * pass moves the submission to the review queue (step 4 of 4).
 */

export interface BadgeStepProps {
  /** Same-origin copies of the badges, for the previews on this page. */
  badgePreviewUrls: { dark: string; light: string }
  /** The public badge URLs the snippets embed. */
  badgeUrls: { dark: string; light: string }
  listingUrl: string
  showPaid: boolean
  signedInEmail: string
  siteName: string
  submission: SubmissionSummary
}

type Outcome = { code: string; href?: string; rel?: string[]; source?: string } | null

/** "nofollow", "nofollow and ugc", "nofollow, sponsored and ugc" */
function joinTokens(tokens: string[]): string {
  if (tokens.length <= 1) return tokens[0] ?? ''
  return `${tokens.slice(0, -1).join(', ')} and ${tokens.at(-1)}`
}

/** `nofollow`, `sponsored`, or `ugc`, as inline code. */
function UnfollowedTokens() {
  return (
    <>
      <code>nofollow</code>, <code>sponsored</code>, or <code>ugc</code>
    </>
  )
}

const UNREACHABLE: Record<string, string> = {
  fetch_timeout: 'The site didn’t respond within 8 seconds.',
  invalid_redirect: 'The site sent a redirect we couldn’t follow.',
  invalid_target: 'The address isn’t a public website.',
  not_html: 'The address didn’t return an HTML page.',
  response_too_large: 'The page is larger than 1 MB.',
  site_unreachable: 'We couldn’t connect to the site.',
  too_many_redirects: 'The site redirected more than 3 times.',
  verification_service_error: 'Our checker had a problem reading the page.'
}

function unreachableReason(code: string): string {
  const status = code.match(/^http_(\d{3})$/u)?.[1]
  if (status) return `The site answered with HTTP ${status}.`
  return UNREACHABLE[code] ?? 'We couldn’t load the page.'
}

function formatCountdown(seconds: number): string {
  const whole = Math.max(0, Math.ceil(seconds))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
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

function BadgeCard({
  embed,
  previewUrl,
  theme
}: {
  previewUrl: string
  embed: string
  theme: 'dark' | 'light'
}) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(embed)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }
  return (
    <Card className="min-w-0 gap-4">
      <CardHeader>
        <CardTitle>{theme === 'light' ? 'Light badge' : 'Dark badge'}</CardTitle>
        <CardAction>
          <Tooltip open={copied}>
            <TooltipTrigger asChild>
              <Button variant="outline" size="sm" onClick={copy}>
                {copied ? <Check /> : <Copy />}
                {copied ? 'Copied' : 'Copy code'}
              </Button>
            </TooltipTrigger>
            <TooltipContent>Copied to clipboard</TooltipContent>
          </Tooltip>
        </CardAction>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-3">
          <img
            src={previewUrl}
            alt={`Featured on SERP Best badge, ${theme}`}
            width={180}
            height={45}
            className="h-auto w-[180px]"
          />
          <figure
            data-slot="textarea"
            aria-label={`${theme} badge snippet`}
            className="w-full overflow-x-auto rounded-md border border-input bg-transparent px-3 py-2 font-mono text-[11px] leading-relaxed shadow-xs dark:bg-input/30"
          >
            <div className="whitespace-pre">{embed}</div>
          </figure>
        </div>
      </CardContent>
    </Card>
  )
}

export function BadgeStep({
  badgePreviewUrls,
  badgeUrls,
  listingUrl,
  showPaid,
  signedInEmail,
  siteName,
  submission: initial
}: BadgeStepProps) {
  const [submission, setSubmission] = useState(initial)
  const [checking, setChecking] = useState(false)
  // Owner decision on #84: one click starts one check. Clicks while it runs, even before the
  // button re-renders as disabled, are dropped.
  const inFlight = useRef(false)
  const [outcome, setOutcome] = useState<Outcome>(
    initial.lastVerificationError ? { code: initial.lastVerificationError } : null
  )
  // When the outbound check budget allows another check (429 `check_budget`); until then
  // Verify stays disabled with the countdown, and nothing else changes.
  const [budgetUntil, setBudgetUntil] = useState(0)
  const lastAt = verificationInstant(submission.lastVerificationAt)
  const cooldownUntil = lastAt === null ? 0 : lastAt + VERIFICATION_COOLDOWN_SECONDS * 1000
  const now = useNow(Math.max(cooldownUntil, budgetUntil) > Date.now())
  // Clamped: the claim time is stored to the second, so clock skew could read 0:31.
  const cooldownSeconds = Math.min(
    VERIFICATION_COOLDOWN_SECONDS,
    Math.max(0, (cooldownUntil - now) / 1000)
  )
  const budgetSeconds = Math.max(0, (budgetUntil - now) / 1000)
  const paused = checksPaused(submission)
  const left = checksLeft(submission)
  const site = submission.website
  const domain = hostOf(site)
  const embeds = {
    dark: buildFeaturedOnBadgeEmbedHtml({ badgeUrl: badgeUrls.dark, listingUrl, siteName }),
    light: buildFeaturedOnBadgeEmbedHtml({ badgeUrl: badgeUrls.light, listingUrl, siteName })
  }

  async function verify() {
    if (inFlight.current) return
    inFlight.current = true
    setChecking(true)
    const response = await verifyBadge(submission.id).finally(() => {
      inFlight.current = false
      setChecking(false)
    })
    if (response.ok) {
      setSubmission(response.data.submission)
      setOutcome(response.data.result.ok ? null : response.data.result)
      return
    }
    const { error } = response
    const current = error.submission
    if (response.status === 409) {
      // Checked elsewhere first (another tab, or a check that finished first), or no longer
      // waiting for its badge: show the submission as it is now (PR #84 review round 2,
      // finding 4). The server routes any other status to its own page.
      if (!current || (current.status !== 'pending_badge' && current.status !== 'verified')) {
        window.location.reload()
        return
      }
      setSubmission(current)
      setOutcome(current.lastVerificationError ? { code: current.lastVerificationError } : null)
      return
    }
    // A refused check still started the cooldown the page may not know about.
    if (current) setSubmission(current)
    if (error.code === 'check_budget') {
      setBudgetUntil(Date.now() + (error.retryAfterSeconds ?? VERIFICATION_COOLDOWN_SECONDS) * 1000)
      return
    }
    if (error.code === 'cooldown') {
      setOutcome({ code: 'cooldown' })
      return
    }
    if (response.error.code === 'attempt_limit') {
      setSubmission(current => ({ ...current, verificationAttempts: VERIFICATION_ATTEMPT_LIMIT }))
      setOutcome({ code: 'attempt_limit' })
      return
    }
    setOutcome({ code: 'verification_service_error' })
  }

  if (submission.status === 'verified') {
    // Each card promises a later step of #59 (#65, #66), so each waits for its flag.
    const { addFaqsAndLinks, keepTheBadgeUp } = featureCopy()
    return (
      <section className="mx-auto w-full max-w-3xl px-4 py-10 md:py-14">
        <div className="flex flex-col gap-6">
          <StepProgress label="Review" step={4} total={4} />
          <ToneAlert tone="success" title="Badge verified">
            <p>We found the badge on {site} with a dofollow link to your listing.</p>
          </ToneAlert>
          <Card>
            <CardHeader>
              <CardTitle>
                <h1 className="font-semibold text-2xl tracking-tight">
                  {submission.name} is in the review queue
                </h1>
              </CardTitle>
              <CardDescription>
                A reviewer looks at it next. We’ll email {signedInEmail} with the result.
              </CardDescription>
            </CardHeader>
            {keepTheBadgeUp || addFaqsAndLinks ? (
              <CardContent>
                <div className="grid gap-4 md:grid-cols-2">
                  {keepTheBadgeUp ? (
                    <Item variant="muted">
                      <ItemMedia variant="icon">
                        <ShieldCheck />
                      </ItemMedia>
                      <ItemContent>
                        <ItemTitle>{keepTheBadgeUp.title}</ItemTitle>
                        <ItemDescription>{keepTheBadgeUp.description}</ItemDescription>
                      </ItemContent>
                    </Item>
                  ) : null}
                  {addFaqsAndLinks ? (
                    <Item variant="muted">
                      <ItemMedia variant="icon">
                        <Plus />
                      </ItemMedia>
                      <ItemContent>
                        <ItemTitle>{addFaqsAndLinks.title}</ItemTitle>
                        <ItemDescription>{addFaqsAndLinks.description}</ItemDescription>
                      </ItemContent>
                    </Item>
                  ) : null}
                </div>
              </CardContent>
            ) : null}
            <CardFooter>
              <Button asChild>
                <Link href="/account/">
                  Go to my account
                  <ArrowRight />
                </Link>
              </Button>
            </CardFooter>
          </Card>
        </div>
      </section>
    )
  }

  const waitSeconds = Math.max(cooldownSeconds, budgetSeconds)
  const coolingDown = waitSeconds > 0 && !paused
  let result: ReactNode = null
  const code = paused ? 'attempt_limit' : outcome?.code
  if (code === 'attempt_limit') {
    result = (
      <ToneAlert
        tone="destructive"
        title="Automatic checks are paused"
        actions={
          <>
            <Button asChild size="sm" variant="outline">
              <Link href="/contact/">
                <MessageSquare />
                Message us
              </Link>
            </Button>
            {showPaid ? (
              <Button asChild size="sm" variant="outline">
                <a href={`/submit/${submission.id}/checkout/`}>Skip the badge: $49 one-off</a>
              </Button>
            ) : null}
          </>
        }
      >
        <p>
          {showPaid
            ? 'None of your last 10 checks found a working badge. Your submission is saved. Message us and we’ll look at it with you, or skip the badge for a $49 one-off payment.'
            : 'None of your last 10 checks found a working badge. Your submission is saved. Message us and we’ll look at it with you.'}
        </p>
      </ToneAlert>
    )
  } else if (code === 'cooldown') {
    result = coolingDown ? (
      <ToneAlert icon={Clock} title="One check every 30 seconds">
        <p>
          You can check again in{' '}
          <b className="text-foreground tabular-nums">{formatCountdown(cooldownSeconds)}</b>.
        </p>
      </ToneAlert>
    ) : null
  } else if (code === 'badge_missing') {
    result = (
      <ToneAlert tone="warning" title="Page reached, badge not found">
        <p>
          We loaded {site}, but the badge wasn’t in the HTML it returned. Publish the snippet on
          that exact URL, then check again.
        </p>
      </ToneAlert>
    )
  } else if (code === 'link_not_followed' || code === 'nofollow') {
    // The tokens the check just found. After a reload only the result is stored, so the alert
    // gives the general rule, with no sample of tokens the site may not have.
    const found = outcome?.rel?.length ? outcome.rel : code === 'nofollow' ? ['nofollow'] : null
    result = found ? (
      <ToneAlert tone="warning" title={`Badge found, but the link is marked ${joinTokens(found)}`}>
        <p>
          The badge has to be a plain link that search engines follow. Remove{' '}
          {found.map((token, index) => (
            <span key={token}>
              {index > 0 ? (index === found.length - 1 ? ' and ' : ', ') : ''}
              <code>{token}</code>
            </span>
          ))}{' '}
          from its <code>rel</code>, publish the change, then check again.
        </p>
        <div className="mt-2 w-full overflow-x-auto rounded-md border bg-muted/50 px-3 py-2 font-mono text-[11px] text-foreground">
          &lt;a href="{listingUrl}" rel="
          {found.map(token => (
            <span key={token}>
              <span className="rounded bg-red-500/15 px-0.5 text-red-700 line-through dark:text-red-400">
                {token}
              </span>{' '}
            </span>
          ))}
          noopener"&gt;
        </div>
      </ToneAlert>
    ) : (
      <ToneAlert tone="warning" title="Badge found, but the link isn’t followed">
        <p>
          The badge has to be a plain link that search engines follow. Remove <UnfollowedTokens />{' '}
          from its <code>rel</code>, publish the change, then check again.
        </p>
      </ToneAlert>
    )
  } else if (code === 'page_not_followed') {
    const source = outcome?.source
    result = (
      <ToneAlert
        tone="warning"
        title="Badge found, but the page tells search engines not to follow links"
      >
        <p>
          {source === 'header' ? (
            <>
              {site} is served with an <code>X-Robots-Tag</code> header that includes{' '}
              <code>nofollow</code> or <code>none</code>.
            </>
          ) : source === 'meta' ? (
            <>
              {site} has a <code>&lt;meta name="robots"&gt;</code> tag that includes{' '}
              <code>nofollow</code> or <code>none</code>.
            </>
          ) : (
            <>
              {site} has a robots meta tag or an <code>X-Robots-Tag</code> header that includes{' '}
              <code>nofollow</code> or <code>none</code>.
            </>
          )}{' '}
          Search engines then follow no link on the page, the badge included. Remove it, publish the
          change, then check again.
        </p>
      </ToneAlert>
    )
  } else if (code === 'page_unreadable') {
    // A type or encoding the checker can't be sure of (PR #84 review round 5): the approved
    // checker-problem copy, not the unreachable-site one, since nothing about the site is down.
    result = (
      <ToneAlert title="Our checker had a problem reading the page">
        <p>This didn’t use up a check.</p>
      </ToneAlert>
    )
  } else if (code === 'wrong_destination') {
    result = (
      <ToneAlert tone="warning" title="Badge found, but it links elsewhere">
        <p>
          {outcome?.href ? (
            <>
              Your badge links to <b>{outcome.href}</b>.{' '}
            </>
          ) : null}
          It has to link to your listing: <b>{listingUrl}</b>. Replace it with the snippet above,
          publish, then check again.
        </p>
      </ToneAlert>
    )
  } else if (code) {
    result = (
      <ToneAlert icon={Globe} title={`We couldn’t reach ${domain}`}>
        <p>
          {unreachableReason(code)} Make sure the page is public and that a firewall or bot
          protection isn’t blocking our checker. This didn’t use up a check.
        </p>
      </ToneAlert>
    )
  }

  return (
    <section className="mx-auto w-full max-w-3xl px-4 py-10 md:py-14">
      <div className="flex flex-col gap-6">
        <StepProgress label="Badge" step={3} total={4} />
        <div className="flex items-start gap-4">
          <ProductLogo name={submission.name} size={48} src={submission.logoUrl} />
          <div>
            <h1 className="font-semibold text-2xl tracking-tight">Add the badge to {domain}</h1>
            <p className="mt-1 text-muted-foreground text-sm">
              Paste a snippet into the HTML of <b className="font-medium text-foreground">{site}</b>
              . The footer works well. Keep it a plain link: don’t add <UnfollowedTokens /> to its{' '}
              <code className="rounded bg-muted px-1 font-mono text-xs">rel</code>.
            </p>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <BadgeCard embed={embeds.light} previewUrl={badgePreviewUrls.light} theme="light" />
          <BadgeCard embed={embeds.dark} previewUrl={badgePreviewUrls.dark} theme="dark" />
        </div>
        <p className="break-all text-muted-foreground text-xs">
          Both badges link to your future listing: {listingUrl}
        </p>
        <Card className="gap-4">
          <CardHeader>
            <CardTitle>Verify the badge</CardTitle>
            <CardDescription>
              We load {site} and look for the badge and its dofollow link.
            </CardDescription>
            <CardAction>
              {checking ? (
                <Button disabled>
                  <Spinner />
                  Checking…
                </Button>
              ) : coolingDown ? (
                <Button disabled>
                  <Clock />
                  Check again in {formatCountdown(waitSeconds)}
                </Button>
              ) : (
                <Button disabled={paused} onClick={verify}>
                  <ShieldCheck />
                  Verify badge
                </Button>
              )}
            </CardAction>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-3">
              {result}
              <p className="text-muted-foreground text-xs">
                <b className="text-foreground tabular-nums">
                  {left} of {VERIFICATION_ATTEMPT_LIMIT}
                </b>{' '}
                checks left · one every 30 seconds · connection problems don’t use up a check
              </p>
            </div>
          </CardContent>
        </Card>
        <p className="text-muted-foreground text-sm">
          You can leave this page and finish later from your account.
          {showPaid ? (
            <>
              {' '}
              Rather not add a badge?{' '}
              <Button asChild variant="link" className="h-auto p-0">
                <a href={`/submit/${submission.id}/checkout/`}>Skip the badge: $49 one-off</a>
              </Button>
            </>
          ) : null}
        </p>
      </div>
    </section>
  )
}

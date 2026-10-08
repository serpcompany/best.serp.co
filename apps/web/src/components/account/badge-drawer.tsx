'use client'

import { Button } from '@serpdirectory/design-system/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger
} from '@serpdirectory/design-system/collapsible'
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle
} from '@serpdirectory/design-system/drawer'
import { Separator } from '@serpdirectory/design-system/separator'
import { Spinner } from '@serpdirectory/design-system/spinner'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@serpdirectory/design-system/table'
import { useIsMobile } from '@serpdirectory/design-system/use-mobile'
import { buildFeaturedOnBadgeEmbedHtml } from '@/components/website/featured-on-badge-embed-panel'
import { ChevronsUpDown, Copy, RefreshCw } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { ToneAlert } from '@/components/submit/submit-ui'
import { formatFull, formatWhen } from '@/lib/account/format'
import { type AccountRow, badgeResultLabel } from '@/lib/account/view'
import { hostOf, VERIFICATION_COOLDOWN_SECONDS } from '@/lib/submissions/contract'
import { verifyListingBadge } from './account-api'
import { Kv } from './record'
import { CheckResultBadge } from './status'

/**
 * A free listing's badge panel (#70 screen 5): a right-side Drawer (a bottom sheet on mobile)
 * with the last check and its result, the embed code, the history, and "Re-verify now", which
 * runs the badge step's check (#84) under its limits: one check every 30 seconds and ten that
 * find a result. As the owner decided for the badge step, the button is disabled from the
 * first click, while the check runs and through the cooldown; later clicks do nothing. Until
 * the badge program (#66) ships, nothing here promises a schedule (`feature-copy.ts`).
 */

export interface BadgePanelCopy {
  description: string
  failingNote: string | null
  failingTitle: string
  programCheckBy: string
}

function failureText(reason: string | null, website: string, listingUrl: string): string {
  const site = hostOf(website)
  switch (reason) {
    case 'badge_missing':
      return `We loaded ${site}, but the badge wasn’t in the HTML it returned.`
    case 'link_not_followed':
    case 'nofollow':
      return `The badge on ${site} links to your listing, but the link is marked nofollow, sponsored, or ugc. It has to be a plain link that search engines follow.`
    case 'page_not_followed':
      return `${site} tells search engines not to follow its links (a robots nofollow rule), so they skip the badge too.`
    case 'wrong_destination':
      return `Badge found, but it links elsewhere. It has to link to your listing: ${listingUrl}.`
    default:
      return `We couldn’t check ${site}.`
  }
}

export function BadgeDrawer({
  copy,
  onOpenChange,
  row,
  siteName
}: {
  copy: BadgePanelCopy
  onOpenChange: (open: boolean) => void
  row: AccountRow | null
  siteName: string
}) {
  const isMobile = useIsMobile()
  const router = useRouter()
  const badge = row?.badge ?? null
  const [checking, setChecking] = useState(false)
  const [coolUntil, setCoolUntil] = useState(0)
  // 0 until mounted, so the server and the first client render agree.
  const [now, setNow] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)
  const inFlight = useRef(false)
  const listingId = badge?.listingId

  useEffect(() => {
    setNow(Date.now())
  }, [])

  useEffect(() => {
    if (listingId === undefined) return
    setNotice(null)
  }, [listingId])

  const cooldownEndsAt = badge?.cooldownEndsAt ?? 0
  useEffect(() => {
    if (Math.max(coolUntil, cooldownEndsAt) <= now) return
    const timer = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(timer)
  }, [coolUntil, cooldownEndsAt, now])

  if (!row || !badge) return null
  const embed = buildFeaturedOnBadgeEmbedHtml({
    badgeUrl: badge.badgeUrl,
    listingUrl: badge.listingUrl,
    siteName
  })
  // The server's cooldown runs from the latest check, here or in another tab.
  const until = Math.max(coolUntil, badge.cooldownEndsAt)
  const waiting = Math.min(
    VERIFICATION_COOLDOWN_SECONDS,
    Math.max(0, Math.ceil((until - now) / 1000))
  )
  const disabled = checking || waiting > 0 || badge.checksLeft === 0

  async function verify() {
    if (inFlight.current || !badge) return
    inFlight.current = true
    setChecking(true)
    setNotice(null)
    const response = await verifyListingBadge(badge.listingId)
    inFlight.current = false
    setChecking(false)
    const started = Date.now()
    setNow(started)
    if (!response.ok) {
      const retry = response.error.retryAfterSeconds
      setCoolUntil(started + (retry ?? VERIFICATION_COOLDOWN_SECONDS) * 1000)
      // A cooldown or a cap the page didn't know about: catch up, with no extra copy.
      if (response.error.code !== 'cooldown') toast.error(response.error.error)
      router.refresh()
      return
    }
    setCoolUntil(started + VERIFICATION_COOLDOWN_SECONDS * 1000)
    const result = response.data.result
    if (
      !result.ok &&
      !['badge_missing', 'link_not_followed', 'page_not_followed', 'wrong_destination'].includes(
        result.code
      )
    ) {
      setNotice(
        `We couldn’t reach ${hostOf(row?.website ?? '')}. Make sure the page is public. This didn’t use up a check.`
      )
    }
    router.refresh()
  }

  const last = badge.last
  return (
    <Drawer
      direction={isMobile ? 'bottom' : 'right'}
      open
      onOpenChange={open => {
        if (!open) onOpenChange(false)
      }}
    >
      <DrawerContent className="data-[vaul-drawer-direction=right]:sm:max-w-md">
        <DrawerHeader>
          <DrawerTitle>{row.name} badge</DrawerTitle>
          <DrawerDescription>{copy.description}</DrawerDescription>
        </DrawerHeader>
        <div className="flex flex-col gap-4 overflow-y-auto px-4 text-sm">
          <Kv
            rows={[
              ['Last check', last ? formatFull(last.at) : 'Not checked yet'],
              [
                'Result',
                last ? (
                  <CheckResultBadge
                    key="result"
                    conclusive={last.conclusive}
                    label={badgeResultLabel(last)}
                    outcome={last.outcome}
                  />
                ) : (
                  '—'
                )
              ]
            ]}
          />
          {badge.failing && last ? (
            <ToneAlert tone="warning" title={copy.failingTitle}>
              <p>
                {failureText(last.reason, row.website, badge.listingUrl)}
                {copy.failingNote ? ` ${copy.failingNote}` : ''}
              </p>
            </ToneAlert>
          ) : null}
          {notice ? <ToneAlert title="We couldn’t check the badge">{notice}</ToneAlert> : null}
          <Separator />
          <Collapsible defaultOpen className="flex flex-col gap-2">
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm" className="-mx-2 justify-between">
                Badge code
                <ChevronsUpDown />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="flex flex-col gap-2">
              <div className="w-full overflow-x-auto rounded-md border border-input px-3 py-2 font-mono text-[11px] leading-relaxed shadow-xs dark:bg-input/30">
                <pre className="whitespace-pre">{embed}</pre>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="w-fit"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(embed)
                    .then(() => toast.success('Badge code copied.'))
                    .catch(() => toast.error('Couldn’t copy. Select the code and copy it.'))
                }}
              >
                <Copy />
                Copy code
              </Button>
            </CollapsibleContent>
          </Collapsible>
          <Separator />
          <div className="flex flex-col gap-2">
            <p className="font-medium">History</p>
            <div className="overflow-hidden rounded-lg border">
              <Table>
                <TableHeader className="bg-muted">
                  <TableRow>
                    <TableHead className="pl-4">When (UTC)</TableHead>
                    <TableHead>Result</TableHead>
                    <TableHead className="pr-4">By</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {badge.history.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={3} className="h-16 text-center text-muted-foreground">
                        No checks yet.
                      </TableCell>
                    </TableRow>
                  ) : (
                    badge.history.map(check => (
                      <TableRow key={`${check.at}-${check.by}`}>
                        <TableCell className="pl-4">{formatWhen(check.at)}</TableCell>
                        <TableCell>
                          <CheckResultBadge
                            conclusive={check.conclusive}
                            label={
                              check.outcome === 'pass'
                                ? 'Pass'
                                : check.conclusive
                                  ? 'Fail'
                                  : 'Inconclusive'
                            }
                            outcome={check.outcome}
                          />
                        </TableCell>
                        <TableCell className="pr-4">
                          {check.by === 'owner' ? 'You' : copy.programCheckBy}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </div>
        </div>
        <DrawerFooter>
          <Button disabled={disabled} onClick={() => void verify()}>
            {checking ? <Spinner /> : <RefreshCw />}
            {checking
              ? 'Checking…'
              : waiting > 0
                ? `Check again in 0:${String(waiting).padStart(2, '0')}`
                : 'Re-verify now'}
          </Button>
          <p className="text-center text-xs text-muted-foreground">
            <b className="tabular-nums text-foreground">{badge.checksLeft} of 10</b> checks left
            today · one every 30 seconds
          </p>
          {row?.upgrade ? (
            <Button asChild variant="outline">
              {/* A plain link: the checkout route opens a provider checkout (#68). */}
              <a href={row.upgrade.href}>{row.upgrade.label}</a>
            </Button>
          ) : null}
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  )
}

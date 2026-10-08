'use client'

import { ArrowLeft, ArrowRight, ExternalLink, RefreshCw } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { type ReactNode, useEffect } from 'react'
import { Kv } from '@/components/admin/kv'
import { StatusBadge, type StatusKind } from '@/components/admin/status-badge'
import { buttonVariants } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle
} from '@/components/ui/card'
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle
} from '@/components/ui/item'
import { Spinner } from '@/components/ui/spinner'
import { formatUsd } from '@/lib/admin/format'
import { ProductLogo, ToneAlert } from './submit-ui'

/**
 * The paid checkout screens (#68; #70 screen 4, approved copy in
 * docs/mockups/submissions/COPY.md, with the payment provider never named: owner decision on
 * #70): the handoff to checkout (4a), and the return states:
 * confirming (4c), live and in review (4d), checks failed (4e), cancelled (4f), and failed (4g).
 * The checkout itself opens from `startHref`, a route that opens (or reuses) the provider's
 * checkout and redirects there.
 */

export interface CheckoutProduct {
  logoUrl: string | null
  name: string
  slug: string
}

export interface CheckoutOrder {
  amountCents: number
  email: string
  number: number
}

function Page({ children }: { children: ReactNode }) {
  return (
    <section className="mx-auto w-full max-w-xl px-4 py-12">
      <div className="flex flex-col gap-6">{children}</div>
    </section>
  )
}

function OrderItem({
  amountCents,
  product,
  status
}: {
  amountCents: number
  product: CheckoutProduct
  status?: StatusKind
}) {
  return (
    <Item variant="outline">
      <ItemMedia>
        <ProductLogo name={product.name} size={40} src={product.logoUrl} />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>Paid listing: {product.name}</ItemTitle>
        <ItemDescription>One-off payment, USD. The listing is permanent.</ItemDescription>
      </ItemContent>
      <ItemActions>
        <div className="flex flex-col items-end gap-1">
          <span className="font-semibold text-base tabular-nums">{formatUsd(amountCents)}</span>
          {status ? <StatusBadge kind={status} /> : null}
        </div>
      </ItemActions>
    </Item>
  )
}

function OrderDetails({ order }: { order: CheckoutOrder }) {
  return (
    <Kv
      rows={[
        ['Order', <span key="order" className="font-mono">{`ORD-${order.number}`}</span>],
        ['Amount', `${formatUsd(order.amountCents)} USD, one-off`],
        ['Status', <StatusBadge key="status" kind="o_paid" />],
        // A 100%-off promotion code (#250) charged nothing, so no receipt is sent.
        ...(order.amountCents === 0
          ? []
          : [
              ['Receipt', `Emailed to ${order.email} by our payment provider`] as [
                string,
                ReactNode
              ]
            ])
      ]}
    />
  )
}

function Actions({ children }: { children: ReactNode }) {
  return <div className="flex w-full flex-col gap-2 sm:flex-row">{children}</div>
}

/** 4a. Sends the browser on to the checkout (replacing this page, so Back skips it). */
export function CheckoutHandoff({
  amountCents,
  backHref,
  product,
  startHref
}: {
  amountCents: number
  backHref: string
  product: CheckoutProduct
  startHref: string
}) {
  useEffect(() => {
    window.location.replace(startHref)
  }, [startHref])
  const steps: Array<[string, string]> = [
    [
      'We run automatic checks',
      'The URL is public and loads, isn’t already listed, and passes our safe-fetch rules.'
    ],
    [
      `Checks pass: ${product.name} goes live`,
      `Within about a minute, at /products/${product.slug}/.`
    ],
    [
      'A reviewer still looks at it',
      'If it’s rejected for anything other than prohibited content, you get a full refund automatically.'
    ]
  ]
  return (
    <Page>
      <Card>
        <CardHeader>
          <CardTitle>
            <h1 className="flex items-center gap-2 font-semibold text-2xl tracking-tight">
              <Spinner className="size-5" /> Taking you to secure checkout
            </h1>
          </CardTitle>
          <CardDescription>
            You’ll pay on our payment provider’s secure checkout page and come straight back here.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-6">
            <OrderItem amountCents={amountCents} product={product} />
            <div>
              <p className="font-medium text-sm">After you pay</p>
              <ol className="mt-3 grid gap-3 text-sm">
                {steps.map(([title, text], index) => (
                  <li key={title} className="flex gap-3">
                    <span className="flex size-6 shrink-0 items-center justify-center rounded-full border font-medium text-xs">
                      {index + 1}
                    </span>
                    <div>
                      <p className="font-medium">{title}</p>
                      <p className="text-muted-foreground">{text}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </CardContent>
        <CardFooter>
          <Actions>
            <a href={startHref} className={buttonVariants()}>
              Continue to checkout
              <ExternalLink />
            </a>
            <Link href={backHref} className={buttonVariants({ variant: 'ghost' })}>
              <ArrowLeft />
              Back to options
            </Link>
          </Actions>
        </CardFooter>
      </Card>
    </Page>
  )
}

/** 4c. The payment isn't confirmed yet: refreshes until it is (at most about a minute). */
export function CheckoutConfirming({
  amountCents,
  product
}: {
  amountCents: number
  product: CheckoutProduct
}) {
  const router = useRouter()
  useEffect(() => {
    let refreshes = 0
    const timer = window.setInterval(() => {
      refreshes += 1
      if (refreshes > 30) window.clearInterval(timer)
      else router.refresh()
    }, 2000)
    return () => window.clearInterval(timer)
  }, [router])
  return (
    <Page>
      <Card>
        <CardHeader>
          <CardTitle>
            <h1 className="flex items-center gap-2 font-semibold text-xl">
              <Spinner className="size-5" /> Confirming your payment…
            </h1>
          </CardTitle>
          <CardDescription>
            This usually takes a few seconds. You can keep this page open or check your account
            later.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <OrderItem amountCents={amountCents} product={product} />
        </CardContent>
      </Card>
    </Page>
  )
}

/** 4d. Paid, the checks passed: live now, and in review. */
export function CheckoutLive({
  listingUrl,
  order,
  product
}: {
  listingUrl: string
  order: CheckoutOrder
  product: CheckoutProduct
}) {
  return (
    <Page>
      <ToneAlert tone="success" title="Payment received">
        <p>Thanks. {product.name} passed our automatic checks.</p>
      </ToneAlert>
      <Card>
        <CardHeader>
          <CardTitle>
            <h1 className="font-semibold text-2xl tracking-tight">
              {product.name} is live on SERP
            </h1>
          </CardTitle>
          <CardDescription className="break-all">{listingUrl}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-6">
            <ToneAlert tone="info" title="Still in review">
              <p>
                Our team reviews every paid listing. If we reject {product.name} for anything other
                than prohibited content, you get a full refund automatically.
              </p>
            </ToneAlert>
            <OrderDetails order={order} />
          </div>
        </CardContent>
        <CardFooter>
          <Actions>
            <a
              href={`/products/${product.slug}/`}
              target="_blank"
              rel="noreferrer"
              className={buttonVariants()}
            >
              View your listing
              <ExternalLink />
            </a>
            <Link href="/account/" className={buttonVariants({ variant: 'outline' })}>
              Go to my account
            </Link>
          </Actions>
        </CardFooter>
      </Card>
    </Page>
  )
}

/** 4e. Paid, a check failed: waits for review. */
export function CheckoutHeld({
  order,
  problem,
  product,
  website
}: {
  order: CheckoutOrder
  problem: string
  product: CheckoutProduct
  website: string
}) {
  return (
    <Page>
      <ToneAlert tone="warning" title="Payment received, waiting for review">
        <p>
          Our checks couldn’t load {website} ({problem}).
        </p>
      </ToneAlert>
      <Card>
        <CardHeader>
          <CardTitle>
            <h1 className="font-semibold text-2xl tracking-tight">
              {product.name} goes live after review
            </h1>
          </CardTitle>
          <CardDescription>
            A reviewer will look at it before it’s published. You don’t need to do anything. If it’s
            rejected for anything other than prohibited content, you get a full refund
            automatically.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <OrderDetails order={order} />
        </CardContent>
        <CardFooter>
          <Link href="/account/" className={buttonVariants()}>
            Go to my account
          </Link>
        </CardFooter>
      </Card>
    </Page>
  )
}

/** 4f. Back from checkout without paying. */
export function CheckoutCancelled({
  amountCents,
  backHref,
  product,
  startHref
}: {
  amountCents: number
  backHref: string
  product: CheckoutProduct
  startHref: string
}) {
  return (
    <Page>
      <Card>
        <CardHeader>
          <CardTitle>
            <h1 className="font-semibold text-2xl tracking-tight">Checkout cancelled</h1>
          </CardTitle>
          <CardDescription>
            You weren’t charged. {product.name} is saved in your account, so you can pick it up any
            time.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <OrderItem amountCents={amountCents} product={product} status="not_paid" />
        </CardContent>
        <CardFooter>
          <Actions>
            <a href={startHref} className={buttonVariants()}>
              Return to checkout
              <ArrowRight />
            </a>
            <Link href={backHref} className={buttonVariants({ variant: 'outline' })}>
              Back to options
            </Link>
          </Actions>
        </CardFooter>
      </Card>
    </Page>
  )
}

/** 4g. The payment didn't go through. */
export function CheckoutFailed({
  amountCents,
  backHref,
  orderNumber,
  product,
  startHref
}: {
  amountCents: number
  backHref: string
  orderNumber: number
  product: CheckoutProduct
  startHref: string
}) {
  return (
    <Page>
      <ToneAlert tone="destructive" title="Payment didn’t go through">
        <p>Your payment was declined, so you weren’t charged.</p>
      </ToneAlert>
      <Card>
        <CardHeader>
          <CardTitle>
            <h1 className="font-semibold text-2xl tracking-tight">Try the payment again</h1>
          </CardTitle>
          <CardDescription>
            {product.name} is saved. Nothing is published until a payment succeeds or the badge is
            verified.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-3">
            <OrderItem amountCents={amountCents} product={product} status="o_failed" />
            <p className="text-muted-foreground text-xs">
              Order <span className="font-mono">{`ORD-${orderNumber}`}</span>
            </p>
          </div>
        </CardContent>
        <CardFooter>
          <Actions>
            <a href={startHref} className={buttonVariants()}>
              <RefreshCw />
              Try again
            </a>
            <Link href={backHref} className={buttonVariants({ variant: 'outline' })}>
              Back to options
            </Link>
          </Actions>
        </CardFooter>
      </Card>
    </Page>
  )
}

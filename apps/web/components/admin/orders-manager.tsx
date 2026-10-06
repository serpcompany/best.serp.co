'use client'

import { Alert, AlertDescription, AlertTitle } from '@serpdirectory/design-system/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@serpdirectory/design-system/alert-dialog'
import { Button } from '@serpdirectory/design-system/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@serpdirectory/design-system/dropdown-menu'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle
} from '@serpdirectory/design-system/empty'
import { Field, FieldGroup, FieldLabel } from '@serpdirectory/design-system/field'
import { Input } from '@serpdirectory/design-system/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@serpdirectory/design-system/table'
import { Tabs, TabsList, TabsTrigger } from '@serpdirectory/design-system/tabs'
import {
  Box,
  CircleCheck,
  Copy,
  EllipsisVertical,
  ExternalLink,
  TriangleAlert,
  Undo2
} from 'lucide-react'
import { useRouter } from 'next/navigation'
import { type ReactNode, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { adminRequest } from './api'
import { PaginationFooter } from './data-table'
import { formatMonthDayTime, formatUsd } from './format'
import { Kv } from './kv'
import { ProductLogo } from './product-cell'
import { PlanBadge, StatusBadge } from './status-badge'

/**
 * Orders (#68; #70 screen 13, approved copy in docs/mockups/submissions/COPY.md): tabs with
 * counts, a filter, the table (order, date, customer, kind, item, amount, status with its
 * note, the Stripe reference), the row menu, and the refund dialogs. Opening "Refund…" checks
 * the listing's badge at refund first, so the dialog says what the refund will do: a passing
 * badge keeps it live as a free listing (13c), otherwise it is unpublished (13b).
 */

export interface OrderRow {
  amountCents: number
  createdAt: string
  customer: string | null
  id: string
  item: { logoUrl: string | null; name: string; website: string } | null
  kind: 'Paid claim' | 'Paid listing'
  listingHref: string | null
  /** The line under the status (the mockup's notes). */
  note: string | null
  number: number
  refundable: boolean
  status: 'failed' | 'paid' | 'pending' | 'refunded' | 'refunding'
  stripeRef: string | null
  stripeUrl: string | null
}

type StatusTab = 'all' | 'failed' | 'paid' | 'pending' | 'refunded'

const TABS: Array<[StatusTab, string]> = [
  ['all', 'All'],
  ['paid', 'Paid'],
  ['refunded', 'Refunded'],
  ['pending', 'Pending'],
  ['failed', 'Failed']
]

type Preview = {
  badgeCheckId: number | null
  kind: 'refund' | 'rejection'
  listingAction: 'already_unpublished' | 'keep_free' | 'none' | 'unpublish' | null
  listingNow: { live: boolean; paid: boolean } | null
}

const orderLabel = (order: OrderRow) => `ORD-${order.number}`

function shortRef(ref: string): string {
  return ref.length > 12 ? `${ref.slice(0, 12)}…` : ref
}

export function OrdersManager({ actor, orders }: { actor: string; orders: OrderRow[] }) {
  const router = useRouter()
  const [tab, setTab] = useState<StatusTab>('all')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [refunding, setRefunding] = useState<{ order: OrderRow; preview: Preview } | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  const counts = useMemo(() => {
    const byStatus = (status: OrderRow['status']) =>
      orders.filter(order => order.status === status).length
    return {
      all: orders.length,
      failed: byStatus('failed'),
      paid: byStatus('paid'),
      pending: byStatus('pending'),
      refunded: byStatus('refunded')
    }
  }, [orders])
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return orders.filter(
      order =>
        (tab === 'all' || order.status === tab) &&
        (!needle ||
          [orderLabel(order), order.customer ?? '', order.item?.name ?? ''].some(value =>
            value.toLowerCase().includes(needle)
          ))
    )
  }, [orders, query, tab])
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
  const shown = filtered.slice((page - 1) * pageSize, page * pageSize)

  const openRefund = async (order: OrderRow) => {
    setBusy(true)
    const result = await adminRequest<Preview>(`/api/admin/orders/${order.id}/refund-preview`, {})
    setBusy(false)
    if (!result.ok) {
      toast.error(result.message)
      return
    }
    setNote('')
    setRefunding({ order, preview: result })
  }

  const refund = async () => {
    if (!refunding) return
    const { order, preview } = refunding
    setBusy(true)
    const result = await adminRequest<{ listing: string }>(`/api/admin/orders/${order.id}/refund`, {
      badgeCheckId: preview.badgeCheckId,
      note
    })
    setBusy(false)
    setRefunding(null)
    if (!result.ok) {
      toast.error(result.message)
      return
    }
    const name = order.item?.name ?? orderLabel(order)
    const logged = `Logged under ${actor}.`
    toast.success(`Refunded ${formatUsd(order.amountCents)} for ${orderLabel(order)}`, {
      description:
        result.listing === 'unpublished'
          ? `${name} was unpublished (no passing badge). ${logged}`
          : result.listing === 'kept_free'
            ? `${name} stays live as a free listing. ${logged}`
            : result.listing === 'pending'
              ? `The listing update is pending. ${logged}`
              : logged
    })
    router.refresh()
  }

  const copyId = async (order: OrderRow) => {
    try {
      await navigator.clipboard.writeText(orderLabel(order))
    } catch {
      // The clipboard can be unavailable; the order ID is in the row.
    }
  }

  return (
    <>
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <Tabs
          value={tab}
          onValueChange={value => {
            setTab(value as StatusTab)
            setPage(1)
          }}
        >
          <TabsList>
            {TABS.map(([value, label]) => (
              <TabsTrigger key={value} value={value}>
                {label}{' '}
                <span className="inline-flex size-5 items-center justify-center rounded-full bg-muted-foreground/30 px-1 font-medium text-foreground text-xs">
                  {counts[value]}
                </span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <Input
          aria-label="Filter by order, email, or product"
          className="h-8 w-full sm:w-[220px] lg:w-[280px]"
          onChange={event => {
            setQuery(event.target.value)
            setPage(1)
          }}
          placeholder="Filter by order, email, or product…"
          value={query}
        />
      </div>
      {shown.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>No orders</EmptyTitle>
            <EmptyDescription>Paid listings and paid claims appear here.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader className="bg-muted">
              <TableRow>
                <TableHead className="text-foreground first:pl-4">Order</TableHead>
                <TableHead className="text-foreground">Date (UTC)</TableHead>
                <TableHead className="text-foreground">Customer</TableHead>
                <TableHead className="text-foreground">Kind</TableHead>
                <TableHead className="text-foreground">Item</TableHead>
                <TableHead className="text-right text-foreground">Amount</TableHead>
                <TableHead className="text-foreground">Status</TableHead>
                <TableHead className="text-foreground">Stripe</TableHead>
                <TableHead className="text-right text-foreground last:pr-4">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map(order => (
                <TableRow key={order.id} data-order={order.id}>
                  <TableCell className="whitespace-nowrap font-mono text-[13px] first:pl-4">
                    {orderLabel(order)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {formatMonthDayTime(order.createdAt)}
                  </TableCell>
                  <TableCell>{order.customer ?? '—'}</TableCell>
                  <TableCell>{order.kind}</TableCell>
                  <TableCell>
                    {order.item ? (
                      <div className="flex items-center gap-2">
                        <ProductLogo
                          logoUrl={order.item.logoUrl}
                          name={order.item.name}
                          size={22}
                          website={order.item.website}
                        />
                        <span>{order.item.name}</span>
                      </div>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatUsd(order.amountCents)}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col items-start gap-1">
                      <StatusBadge kind={`o_${order.status}`} />
                      {order.note ? (
                        <span className="text-[11px] text-muted-foreground">{order.note}</span>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell className="whitespace-nowrap font-mono text-muted-foreground text-xs">
                    {order.stripeRef ? shortRef(order.stripeRef) : '—'}
                  </TableCell>
                  <TableCell className="last:pr-4">
                    <div className="flex justify-end">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8 text-muted-foreground"
                          >
                            <EllipsisVertical />
                            <span className="sr-only">Open menu for {orderLabel(order)}</span>
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-48">
                          {order.stripeUrl ? (
                            <DropdownMenuItem asChild>
                              <a href={order.stripeUrl} target="_blank" rel="noreferrer">
                                <ExternalLink />
                                View in Stripe
                              </a>
                            </DropdownMenuItem>
                          ) : null}
                          <DropdownMenuItem onSelect={() => void copyId(order)}>
                            <Copy />
                            Copy order ID
                          </DropdownMenuItem>
                          {order.listingHref ? (
                            <DropdownMenuItem asChild>
                              <a href={order.listingHref}>
                                <Box />
                                Open listing
                              </a>
                            </DropdownMenuItem>
                          ) : null}
                          {order.refundable ? (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                disabled={busy}
                                variant="destructive"
                                onSelect={() => void openRefund(order)}
                              >
                                <Undo2 />
                                Refund…
                              </DropdownMenuItem>
                            </>
                          ) : null}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <PaginationFooter
        onPage={setPage}
        onPageSize={size => {
          setPageSize(size)
          setPage(1)
        }}
        page={page}
        pageCount={pageCount}
        pageSize={pageSize}
        summary={`${filtered.length} ${filtered.length === 1 ? 'order' : 'orders'}`}
      />
      {refunding ? (
        <RefundDialog
          busy={busy}
          note={note}
          onCancel={() => setRefunding(null)}
          onConfirm={() => void refund()}
          onNote={setNote}
          order={refunding.order}
          preview={refunding.preview}
        />
      ) : null}
    </>
  )
}

function RefundDialog({
  busy,
  note,
  onCancel,
  onConfirm,
  onNote,
  order,
  preview
}: {
  busy: boolean
  note: string
  onCancel: () => void
  onConfirm: () => void
  onNote: (value: string) => void
  order: OrderRow
  preview: Preview
}) {
  const name = order.item?.name ?? orderLabel(order)
  const amount = formatUsd(order.amountCents)
  const unpublish = preview.listingAction === 'unpublish'
  const keepFree = preview.listingAction === 'keep_free'
  const now = preview.listingNow
  return (
    <AlertDialog
      open
      onOpenChange={open => {
        if (!open && !busy) onCancel()
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {unpublish
              ? `Refund ${amount} and unpublish ${name}?`
              : `Refund ${amount} for ${name}?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            Refunds the full amount to {order.customer ?? 'the customer'} through Stripe. This can’t
            be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <FieldGroup className="gap-5">
          <Kv
            rows={[
              ['Order', `${orderLabel(order)} · ${order.kind} · ${name}`],
              ['Amount', `${amount} to the original payment method`],
              ...((unpublish || keepFree) && now
                ? ([
                    [
                      'Listing now',
                      <span key="now" className="flex flex-wrap items-center gap-1">
                        <StatusBadge kind="live" />
                        <PlanBadge paid={now.paid} />
                      </span>
                    ],
                    [
                      'Listing after refund',
                      unpublish ? (
                        <span key="after" className="flex flex-wrap items-center gap-1">
                          <StatusBadge kind="unlisted" />
                          <span className="font-normal text-muted-foreground">URL returns 410</span>
                        </span>
                      ) : (
                        <span key="after" className="flex flex-wrap items-center gap-1">
                          <StatusBadge kind="live" />
                          <PlanBadge paid={false} />
                        </span>
                      )
                    ]
                  ] as Array<[string, ReactNode]>)
                : [])
            ]}
          />
          {unpublish ? (
            <Alert className="border-amber-500/40 text-amber-700 dark:text-amber-400">
              <TriangleAlert />
              <AlertTitle>{name} has no passing badge</AlertTitle>
              <AlertDescription>
                A refunded listing stays up only if its badge is passing, as a free listing. {name}{' '}
                has no badge, so it’s unpublished.
              </AlertDescription>
            </Alert>
          ) : null}
          {keepFree ? (
            <Alert className="border-emerald-500/40 text-emerald-700 dark:text-emerald-400">
              <CircleCheck />
              <AlertTitle>{name} keeps a passing badge</AlertTitle>
              <AlertDescription>
                It stays live as a free listing and joins the weekly badge checks. If the badge
                later goes missing, the usual warning and recheck apply.
              </AlertDescription>
            </Alert>
          ) : null}
          <Field>
            <FieldLabel htmlFor="refund-note">Reason for the activity log</FieldLabel>
            <Input
              id="refund-note"
              maxLength={500}
              onChange={event => onNote(event.target.value)}
              value={note}
            />
          </Field>
        </FieldGroup>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-white hover:bg-destructive/90"
            disabled={busy}
            onClick={event => {
              event.preventDefault()
              onConfirm()
            }}
          >
            {unpublish ? 'Refund and unpublish' : keepFree ? 'Refund, keep live as free' : 'Refund'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

import { Badge } from '@serpdirectory/design-system/badge'
import { Button } from '@serpdirectory/design-system/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@serpdirectory/design-system/table'
import Link from 'next/link'
import { ProductLogo, SubmissionStatusBadge } from '@/components/submit/submit-ui'
import { hostOf, type SubmissionSummary } from '@/lib/submissions/contract'

/**
 * The account's submissions (#63): the draft and badge rows of the #70 screen 5 table, so a
 * saved draft can be continued and a free submission can finish its badge step. The full
 * dashboard (cards, tabs, listings, badge history) is #65.
 */

export interface AccountSubmissionRow extends SubmissionSummary {
  createdAt: string
  withdrawalReason?: string | null
}

const DATE = new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'short', timeZone: 'UTC' })

function shortDate(value: string): string {
  const parsed = Date.parse(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`)
  return Number.isNaN(parsed) ? '' : DATE.format(parsed)
}

function nextStep(row: AccountSubmissionRow, showPaid: boolean) {
  switch (row.status) {
    case 'draft':
      return {
        action: { href: `/submit/${row.id}/choose/`, label: 'Continue' },
        text: showPaid ? 'Choose free or paid' : 'Choose how to get listed'
      }
    case 'pending_badge':
      return {
        action: { href: `/submit/${row.id}/badge/`, label: 'Add badge' },
        text: 'Add the badge to your site'
      }
    case 'verified':
    case 'paid_pending_review':
      return { action: null, text: 'Waiting for a reviewer' }
    case 'changes_requested':
      return { action: null, text: 'Fix and resubmit' }
    case 'approved':
      return { action: null, text: 'Published on best.serp.co' }
    case 'rejected':
      return { action: null, text: 'Not approved' }
    default:
      return { action: null, text: 'Closed' }
  }
}

export function SubmissionsTable({
  rows,
  showPaid
}: {
  rows: readonly AccountSubmissionRow[]
  showPaid: boolean
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="overflow-hidden rounded-lg border">
        <Table>
          <TableHeader className="bg-muted">
            <TableRow>
              <TableHead>Product</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Plan</TableHead>
              <TableHead>Next step</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(row => {
              const step = nextStep(row, showPaid)
              return (
                <TableRow key={row.id}>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <ProductLogo name={row.name} size={32} src={row.logoUrl} />
                      <div className="min-w-0">
                        <p className="font-medium">{row.name}</p>
                        <p className="text-muted-foreground text-xs">
                          {hostOf(row.website)} · {shortDate(row.createdAt)}
                        </p>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col items-start gap-1">
                      <SubmissionStatusBadge status={row.status} />
                      {row.draftExpiresInDays !== null ? (
                        <span className="text-muted-foreground text-xs">
                          Expires in {row.draftExpiresInDays}{' '}
                          {row.draftExpiresInDays === 1 ? 'day' : 'days'}
                        </span>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell>
                    {row.plan ? (
                      <Badge variant={row.plan === 'paid' ? 'default' : 'outline'}>
                        {row.plan === 'paid' ? 'Paid' : 'Free'}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <span className="text-muted-foreground">{step.text}</span>
                  </TableCell>
                  <TableCell className="text-right">
                    {step.action ? (
                      <Button asChild size="sm">
                        <Link href={step.action.href}>{step.action.label}</Link>
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

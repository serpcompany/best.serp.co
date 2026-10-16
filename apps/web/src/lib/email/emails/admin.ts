/**
 * Admin alerts (#70 screen 15): a submission is ready for review, and a submitter sent a
 * message; and a payment changed outside the site (#473). They go to `EMAIL_ADMIN_RECIPIENT`
 * (site-config); the footer links to the review queue (`audience: 'admin'`). Subjects never
 * carry a submitter's full address: the new-message alert names the sender or their domain.
 */
import { clip, defineEmailTemplate, EmailTemplateError } from '../templates'
import {
  composeEmail,
  formatStamp,
  paragraph,
  required,
  rows,
  SUBJECT_NAME_MAX,
  sitePath
} from './layout'

export type ReviewPlan =
  | { badgeVerifiedAt: Date | string; kind: 'free' }
  /**
   * `loss`: the payment was refunded, or disputed and not won (`payment-kept.ts`, #484), so it's
   * no longer kept; it says so, and never reads as a free plan with a badge check.
   */
  | { kind: 'paid'; live: boolean; loss?: 'disputed' | 'refunded' | null }
  /** A listing with no plan: its owner was assigned by an admin (a revision, #65). */
  | { kind: 'none' }

export interface AdminReviewReadyInput {
  category: string
  plan: ReviewPlan
  /** A new submission, or a revision of a live listing. */
  source: 'revision' | 'submission'
  /** The submission's id, or the revision's (the button opens its review page). */
  submissionId: string
  submissionName: string
  /** The submitter's address, shown to the admin. */
  submittedBy: string
  website: string
}

function planLabels(plan: ReviewPlan): { row: string; subject: string } {
  if (plan.kind === 'free') {
    return {
      row: `Free. Badge verified ${formatStamp(plan.badgeVerifiedAt)}`,
      subject: 'free, badge verified'
    }
  }
  if (plan.kind === 'paid') {
    if (plan.loss === 'disputed' || plan.loss === 'refunded') {
      return { row: `Paid. Payment ${plan.loss}`, subject: `paid, payment ${plan.loss}` }
    }
    return plan.live
      ? { row: 'Paid. Live now', subject: 'paid, live now' }
      : { row: 'Paid. Waiting for review', subject: 'paid, waiting for review' }
  }
  if (plan.kind === 'none') {
    return { row: 'None. An admin assigned the owner', subject: 'owner edit' }
  }
  throw new EmailTemplateError('Unknown review plan.')
}

export const adminReviewReadyEmail = defineEmailTemplate<AdminReviewReadyInput>({
  audience: 'admin',
  id: 'admin-review-ready',
  render(input, context) {
    const name = required(input.submissionName, 'a product name')
    const category = required(input.category, 'a category')
    const submittedBy = required(input.submittedBy, 'the submitter')
    const plan = planLabels(input.plan)
    const host = new URL(context.links.origin).host
    return composeEmail(
      {
        body: [
          rows([
            ['Product', name],
            ['Website', required(input.website, 'a website')],
            ['Category', category],
            ['Source', input.source === 'revision' ? 'Revision' : 'New submission'],
            ['Plan', plan.row],
            ['Submitted by', submittedBy]
          ])
        ],
        cta: {
          label: 'Review submission',
          // A revision is reviewed on its own page (#64); `submissionId` is then its id.
          url: context.links.url(
            sitePath(
              'admin',
              input.source === 'revision' ? 'revisions' : 'submissions',
              input.submissionId
            )
          )
        },
        heading: `${name} is ready for review`,
        preheader: `${category} · submitted by ${submittedBy}`,
        reason: `You’re getting this because ${context.recipient} receives review alerts for ${host}.`,
        subject: `Ready for review: ${clip(name, SUBJECT_NAME_MAX)} (${plan.subject})`
      },
      context
    )
  }
})

export interface AdminNewMessageInput {
  /** What the thread is about, e.g. `Claim: Brieflow (brieflow.ai)`. */
  about: string
  /** The submitter's address, shown in the body only. */
  from: string
  /** The submitter's name for the subject; without one the subject names their domain. */
  fromName?: string
  /** The thread kind for the preview line: Claim, Submission, Listing, or General. */
  kind: string
  threadId: string
  /** A short topic for the subject, e.g. `Brieflow claim`. */
  topic: string
  unread: number
}

export const adminNewMessageEmail = defineEmailTemplate<AdminNewMessageInput>({
  audience: 'admin',
  id: 'admin-new-message',
  render(input, context) {
    const from = required(input.from, 'the sender')
    const sender = input.fromName?.trim() || from.slice(from.lastIndexOf('@') + 1)
    if (!Number.isInteger(input.unread) || input.unread < 1) {
      throw new EmailTemplateError('Expected an unread count.')
    }
    const unread = `${input.unread} ${input.unread === 1 ? 'message' : 'messages'}`
    const host = new URL(context.links.origin).host
    return composeEmail(
      {
        after: [
          paragraph(
            'Messages that arrive within 10 minutes of each other are grouped into one alert.'
          )
        ],
        body: [
          rows([
            ['From', from],
            ['About', required(input.about, 'a topic')],
            ['Unread', unread]
          ])
        ],
        cta: {
          label: 'Open in inbox',
          url: context.links.url(sitePath('admin', 'inbox', input.threadId))
        },
        heading: 'New message from a submitter',
        preheader: `${required(input.kind, 'a thread kind')} · ${input.unread} unread ${input.unread === 1 ? 'message' : 'messages'}`,
        reason: `You’re getting this because ${context.recipient} receives inbox alerts for ${host}.`,
        subject: `New message from ${clip(sender, SUBJECT_NAME_MAX)}: ${clip(required(input.topic, 'a topic'), SUBJECT_NAME_MAX)}`
      },
      context
    )
  }
})

/** What happened to the payment (#473). */
export type PaymentAlertKind =
  | 'disputed'
  /** A dispute won on a payment whose rejection asked no refund while it was open (#483). */
  | 'dispute_won_refund'
  | 'partially_refunded'
  | 'refund_failed'
  | 'refunded'

export interface AdminPaymentAlertInput {
  kind: PaymentAlertKind
  /** Whether the order's listing is live now; null when the order has none. */
  listingLive: boolean | null
  /** The order number people see (`ORD-<number>`). */
  orderNumber: number
  /** The order's listing or submission name, when it has one. */
  productName: string | null
}

const PAYMENT_ALERTS: Readonly<Record<PaymentAlertKind, { heading: string; subject: string }>> = {
  disputed: { heading: 'A payment was disputed', subject: 'Payment disputed' },
  dispute_won_refund: {
    heading: 'A dispute was won, so the rejection’s refund goes ahead',
    subject: 'Dispute won, refunding the rejection'
  },
  partially_refunded: {
    heading: 'A payment was partly refunded outside the site',
    subject: 'Partly refunded outside the site'
  },
  refund_failed: { heading: 'A refund failed', subject: 'Refund failed' },
  refunded: {
    heading: 'A payment was refunded outside the site',
    subject: 'Refunded outside the site'
  }
}

/**
 * A dispute, a refund made outside the site, or a refund that failed (#473), with whether the
 * listing is still live: a dispute or a full refund takes a paid listing down.
 */
export const adminPaymentAlertEmail = defineEmailTemplate<AdminPaymentAlertInput>({
  audience: 'admin',
  id: 'admin-payment-alert',
  render(input, context) {
    const alert = Object.hasOwn(PAYMENT_ALERTS, input.kind) ? PAYMENT_ALERTS[input.kind] : null
    if (!alert) throw new EmailTemplateError('Unknown payment alert.')
    if (!Number.isInteger(input.orderNumber) || input.orderNumber < 1) {
      throw new EmailTemplateError('Expected an order number.')
    }
    const order = `ORD-${input.orderNumber}`
    const name = input.productName?.trim() || null
    const entries: Array<readonly [string, string]> = [['Order', order]]
    if (name) entries.push(['Product', name])
    if (input.listingLive !== null) {
      entries.push(['Listing', input.listingLive ? 'Live' : 'Unpublished'])
    }
    const host = new URL(context.links.origin).host
    return composeEmail(
      {
        body: [rows(entries)],
        cta: { label: 'Open orders', url: context.links.url(sitePath('admin', 'orders')) },
        heading: alert.heading,
        preheader: name ? `${order} · ${name}` : order,
        reason: `You’re getting this because ${context.recipient} receives order alerts for ${host}.`,
        subject: `${alert.subject}: ${order}${name ? ` (${clip(name, SUBJECT_NAME_MAX)})` : ''}`
      },
      context
    )
  }
})

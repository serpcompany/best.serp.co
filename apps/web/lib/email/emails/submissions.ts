/**
 * Emails about a submission in review: received, payment received while waiting for review,
 * changes requested, rejected, rejected with a refund, and rejected as prohibited (#70 screen
 * 15). Submitter text (names, notes, reasons) is escaped by `html`.
 */
import { clip, defineEmailTemplate } from '../templates'
import {
  bold,
  box,
  composeEmail,
  formatUsd,
  hostOf,
  paragraph,
  quote,
  required,
  rows,
  SUBJECT_NAME_MAX,
  sitePath
} from './layout'

export interface SubmissionReceivedInput {
  category: string
  /** Free submissions reach review once their badge is verified; this email says so. */
  submissionName: string
  website: string
}

export const submissionReceivedEmail = defineEmailTemplate<SubmissionReceivedInput>({
  id: 'submission-received',
  render(input, context) {
    const name = required(input.submissionName, 'a product name')
    const website = required(input.website, 'a website')
    return composeEmail(
      {
        body: [
          paragraph(
            `Thanks for submitting ${name}. We found the badge on ${website} with a dofollow link to your listing, so it’s now waiting for a reviewer.`
          ),
          rows([
            ['Product', name],
            ['Website', website],
            ['Category', required(input.category, 'a category')],
            ['Plan', 'Free (badge)']
          ]),
          paragraph(
            'We’ll email you when it’s been reviewed. Meanwhile, you can add FAQs and links from your dashboard.'
          )
        ],
        cta: { label: 'Open your dashboard', url: context.links.url('/account/') },
        heading: `${name} is in the review queue`,
        preheader: `Your badge checked out. ${name} is in the review queue.`,
        subject: `We received ${clip(name, SUBJECT_NAME_MAX)}`
      },
      context
    )
  }
})

export interface PaymentReceivedInReviewInput {
  /** Why the automatic checks couldn't load the site, e.g. `the connection timed out`. */
  checkProblem: string
  paidCents: number
  submissionId: string
  submissionName: string
  website: string
}

export const paymentReceivedInReviewEmail = defineEmailTemplate<PaymentReceivedInReviewInput>({
  id: 'payment-received-in-review',
  render(input, context) {
    const name = required(input.submissionName, 'a product name')
    return composeEmail(
      {
        body: [
          paragraph(`Thanks for your payment of ${formatUsd(input.paidCents, { cents: true })}.`),
          paragraph(
            `Our automatic checks couldn’t load ${required(input.website, 'a website')} (${required(input.checkProblem, 'the check problem')}), so ${name} isn’t live yet. A reviewer will look at it before it’s published. You don’t need to do anything.`
          ),
          paragraph(
            'If it’s rejected for anything other than prohibited content, you get a full refund automatically.'
          )
        ],
        cta: {
          label: 'View submission',
          url: context.links.url(sitePath('account', 'submissions', input.submissionId))
        },
        heading: `${name} goes live after review`,
        preheader: `${name} goes live after a reviewer looks at it.`,
        subject: `Payment received: ${clip(name, SUBJECT_NAME_MAX)} is in review`
      },
      context
    )
  }
})

export interface ChangesRequestedInput {
  /** The reviewer's note, shown as written (line breaks kept). */
  note: string
  submissionId: string
  submissionName: string
}

export const changesRequestedEmail = defineEmailTemplate<ChangesRequestedInput>({
  id: 'changes-requested',
  render(input, context) {
    const name = required(input.submissionName, 'a product name')
    return composeEmail(
      {
        after: [paragraph('Questions about the note? Reply to the reviewer in your dashboard.')],
        body: [
          paragraph(`${name} isn’t live yet. Our reviewer left this note:`),
          quote(required(input.note, 'a reviewer note')),
          paragraph('Make the changes and resubmit. It goes back into the review queue.')
        ],
        cta: {
          label: 'Edit and resubmit',
          url: context.links.url(sitePath('account', 'submissions', input.submissionId))
        },
        heading: 'A reviewer asked for changes',
        preheader: 'A reviewer left a note. Edit and resubmit when you’re ready.',
        subject: `Changes requested for ${clip(name, SUBJECT_NAME_MAX)}`
      },
      context
    )
  }
})

export interface SubmissionRejectedInput {
  /** The reviewer's reason. Prohibited rejections use `submission-rejected-prohibited`. */
  reason: string
  submissionId: string
  submissionName: string
}

export const submissionRejectedEmail = defineEmailTemplate<SubmissionRejectedInput>({
  id: 'submission-rejected',
  render(input, context) {
    const name = required(input.submissionName, 'a product name')
    return composeEmail(
      {
        body: [
          paragraph(`A reviewer looked at ${name} and couldn’t approve it this time.`),
          box(bold('Reason:'), ` ${required(input.reason, 'a reason')}`),
          paragraph('You can edit the submission and send it again.')
        ],
        cta: {
          label: 'Open submission',
          url: context.links.url(sitePath('account', 'submissions', input.submissionId))
        },
        heading: `${name} wasn’t approved`,
        preheader: 'Here’s why, and what you can do next.',
        subject: `${clip(name, SUBJECT_NAME_MAX)} wasn’t approved`
      },
      context
    )
  }
})

export interface SubmissionRejectedRefundedInput extends SubmissionRejectedInput {
  /** The refunded amount, in cents (4900 for the $49 listing). */
  refundedCents: number
}

export const submissionRejectedRefundedEmail = defineEmailTemplate<SubmissionRejectedRefundedInput>(
  {
    id: 'submission-rejected-refunded',
    render(input, context) {
      const name = required(input.submissionName, 'a product name')
      const amount = formatUsd(input.refundedCents, { cents: true })
      return composeEmail(
        {
          body: [
            paragraph(`A reviewer looked at ${name} and couldn’t approve it.`),
            box(bold('Reason:'), ` ${required(input.reason, 'a reason')}`),
            paragraph(
              'We’ve refunded ',
              bold(amount),
              ' to your original payment method. It can take 5 to 10 business days to show up.'
            ),
            paragraph('You can fix the site, edit the submission, and send it again.')
          ],
          cta: {
            label: 'Open submission',
            url: context.links.url(sitePath('account', 'submissions', input.submissionId))
          },
          heading: `${name} wasn’t approved`,
          preheader: `Your ${amount} payment has been refunded.`,
          subject: `${clip(name, SUBJECT_NAME_MAX)} wasn’t approved, and we’ve refunded you`
        },
        context
      )
    }
  }
)

export interface SubmissionRejectedProhibitedInput extends SubmissionRejectedInput {
  /** The submitted site; its domain can't be submitted or claimed again. */
  website: string
}

export const submissionRejectedProhibitedEmail =
  defineEmailTemplate<SubmissionRejectedProhibitedInput>({
    id: 'submission-rejected-prohibited',
    render(input, context) {
      const name = required(input.submissionName, 'a product name')
      const domain = hostOf(required(input.website, 'a website'))
      const id = required(input.submissionId, 'a submission id')
      return composeEmail(
        {
          body: [
            paragraph(`A reviewer looked at ${name} and couldn’t approve it.`),
            box(bold('Reason:'), ` ${required(input.reason, 'a reason')}`),
            paragraph(
              `Because the content is prohibited, ${domain} can’t be submitted or claimed again. If you think this is a mistake, message us from your dashboard.`
            )
          ],
          cta: {
            label: 'Message us',
            url: context.links.url(
              `/account/messages/new/?about=submission:${encodeURIComponent(id)}`
            )
          },
          heading: `${name} wasn’t approved`,
          preheader: `${domain} can’t be submitted again.`,
          subject: `${clip(name, SUBJECT_NAME_MAX)} wasn’t approved`
        },
        context
      )
    }
  })

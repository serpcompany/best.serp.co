/**
 * Draft emails (#70 screen 15, revision 4): "Finish your submission" reminders at +12h, +48h,
 * +7d, +14d, and +21d (the last), in two variants, and "Your draft expired" at day 30.
 */
import { defineEmailTemplate, EmailTemplateError } from '../templates'
import {
  bold,
  composeEmail,
  days,
  formatUsd,
  hostOf,
  type Inline,
  paragraph,
  required,
  sitePath
} from './layout'

/** Drafts expire this many days after they were saved (owner decision, #70 revision 4). */
export const DRAFT_LIFETIME_DAYS = 30

export interface DraftReminderInput {
  /** Days until the draft expires. */
  expiresInDays: number
  /** The +21d reminder says it is the last one. */
  lastReminder: boolean
  /** The current paid listing price, in cents. */
  priceCents: number
  productName: string
  submissionId: string
  /** `choose_plan`: no plan chosen yet. `complete_checkout`: paid chosen, checkout unfinished. */
  variant: 'choose_plan' | 'complete_checkout'
  website: string
}

export const draftReminderEmail = defineEmailTemplate<DraftReminderInput>({
  id: 'draft-reminder',
  render(input, context) {
    const name = required(input.productName, 'a product name')
    const domain = hostOf(required(input.website, 'a website'))
    const remaining = days(input.expiresInDays)
    const price = formatUsd(input.priceCents, { cents: false })
    if (input.variant !== 'choose_plan' && input.variant !== 'complete_checkout') {
      throw new EmailTemplateError('Unknown draft reminder variant.')
    }
    const checkout = input.variant === 'complete_checkout'
    const lastLine = `This is the last reminder. After that the draft is deleted and ${domain} can be submitted by anyone. `
    const detail: Inline[] = checkout
      ? [
          `${input.lastReminder ? lastLine : ''}You picked the paid listing but didn’t finish checkout, so you haven’t been charged. Complete the ${price} one-off payment and ${name} goes live as soon as our automatic checks pass. A reviewer still looks at it.`
        ]
      : input.lastReminder
        ? [
            `${lastLine}Pick how to get listed: free with our badge, or ${price} one-off without it.`
          ]
        : [
            `It’s saved with everything you entered. Pick how to get listed: free with our badge, or ${price} one-off without it. Nothing is reviewed until you choose.`
          ]
    return composeEmail(
      {
        after: checkout
          ? [
              paragraph(
                'Rather add our badge instead? You can still switch to the free option from the same page.'
              )
            ]
          : [],
        body: [
          paragraph('Your draft for ', bold(name), ` expires in ${remaining}.`),
          paragraph(...detail)
        ],
        cta: checkout
          ? {
              label: 'Complete checkout',
              url: context.links.url(sitePath('submit', input.submissionId, 'checkout'))
            }
          : {
              label: 'Choose a plan',
              url: context.links.url(sitePath('submit', input.submissionId, 'choose'))
            },
        heading: 'Finish your submission',
        preheader: `Your draft for ${name} expires in ${remaining}.`,
        subject: input.lastReminder
          ? `Last reminder: your ${name} draft expires in ${remaining}`
          : `Finish your submission: ${name}`
      },
      context
    )
  }
})

export interface DraftExpiredInput {
  productName: string
  website: string
}

export const draftExpiredEmail = defineEmailTemplate<DraftExpiredInput>({
  id: 'draft-expired',
  render(input, context) {
    const name = required(input.productName, 'a product name')
    const website = required(input.website, 'a website')
    const domain = hostOf(website)
    return composeEmail(
      {
        body: [
          paragraph(
            'Your draft for ',
            bold(name),
            ` was saved ${DRAFT_LIFETIME_DAYS} days ago without a plan, so it has expired and been removed.`
          ),
          paragraph(
            `The URL ${domain} is released, so it can be submitted again. If you still want it listed, start a new submission. It takes a couple of minutes, and we’ll read your site again to fill in the details.`
          )
        ],
        cta: {
          label: 'Start again',
          url: context.links.url(`/submit/?url=${encodeURIComponent(website)}`)
        },
        heading: 'Your draft expired',
        preheader: `${domain} is available to submit again.`,
        subject: `Your ${name} draft expired`
      },
      context
    )
  }
})

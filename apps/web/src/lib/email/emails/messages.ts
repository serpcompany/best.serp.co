/**
 * Dashboard conversation notices (#70 screen 15, revision 3; inbox in #73). They never carry
 * the message itself, only a link to the conversation. Bursts are throttled by the caller (one
 * email per few minutes), which the copy says.
 */
import { clip, defineEmailTemplate } from '../templates'
import { bold, composeEmail, paragraph, required, SUBJECT_NAME_MAX, sitePath } from './layout'

export interface NewMessageInput {
  /** What the conversation is about, e.g. the product name. */
  about: string
  threadId: string
}

export const newMessageEmail = defineEmailTemplate<NewMessageInput>({
  // The footer links to the conversation itself, as the mockup shows (sent only once #73's
  // inbox exists).
  footerPath: input => sitePath('account', 'messages', input.threadId),
  id: 'new-message',
  render(input, context) {
    const about = required(input.about, 'a conversation topic')
    return composeEmail(
      {
        after: [
          paragraph(
            'If more replies arrive in the next few minutes, we won’t email you again for each one.'
          )
        ],
        body: [
          paragraph(
            'The SERP team replied to your conversation about ',
            bold(about),
            '. Open it in your dashboard to read it and reply.'
          )
        ],
        cta: {
          label: 'Open conversation',
          url: context.links.url(sitePath('account', 'messages', input.threadId))
        },
        heading: 'You have a new message',
        preheader: 'The SERP team replied. Read it in your dashboard.',
        subject: `You have a new message about ${clip(about, SUBJECT_NAME_MAX)}`
      },
      context
    )
  }
})

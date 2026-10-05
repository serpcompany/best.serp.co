/**
 * Sample inputs for every registered email, using the fictional data of the approved mockups
 * (serpcompany/best.serp.co#70, screen 15). Tests and `scripts/email-previews.ts` render these;
 * app code never imports this module.
 */

import type { SiteEnvironment } from '../../environment/site-environment'
import { resolveEmailPolicy } from '../config'
import type { AppEmailTemplates } from '../registry'
import { appEmailTemplates } from '../registry'
import { emailRenderContext } from '../service'
import {
  type EmailTemplate,
  type RenderedEmail,
  renderEmail,
  type TemplateInput
} from '../templates'

type SampleInputs = {
  [K in keyof AppEmailTemplates]: Array<{
    /** The mockup state this sample matches (`#s15-<state>`). */
    mockup: string
    input: TemplateInput<AppEmailTemplates[K]>
    to: string
  }>
}

export const EMAIL_SAMPLES: SampleInputs = {
  'admin-new-message': [
    {
      input: {
        about: 'Claim: Brieflow (brieflow.ai)',
        from: 'priya@brieflow.ai',
        kind: 'Claim',
        threadId: 't_3hq7',
        topic: 'Brieflow claim',
        unread: 1
      },
      mockup: 'adminmessage',
      to: 'devin@serp.co'
    }
  ],
  'admin-review-ready': [
    {
      input: {
        category: 'AI Copywriting',
        plan: { badgeVerifiedAt: '2026-10-06T10:42:00Z', kind: 'free' },
        source: 'submission',
        submissionId: 's_4f9k2c',
        submissionName: 'Quillmate',
        submittedBy: 'maya@quillmate.app',
        website: 'https://quillmate.app/'
      },
      mockup: 'admin',
      to: 'devin@serp.co'
    },
    {
      input: {
        category: 'AI Tutor',
        plan: { kind: 'paid', live: false },
        source: 'submission',
        submissionId: 's_7tq20z',
        submissionName: 'Kiddo Tutor',
        submittedBy: 'team@kiddotutor.com',
        website: 'https://kiddotutor.com/'
      },
      mockup: 'adminpaidwait',
      to: 'devin@serp.co'
    },
    {
      input: {
        category: 'AI Text to Speech',
        plan: { kind: 'paid', live: true },
        source: 'submission',
        submissionId: 's_8m2q1d',
        submissionName: 'Voxbloom',
        submittedBy: 'hello@voxbloom.fm',
        website: 'https://voxbloom.fm/'
      },
      mockup: 'adminpaidlive',
      to: 'devin@serp.co'
    }
  ],
  'badge-missing': [
    {
      input: {
        checkedAt: '2026-10-05T09:14:00Z',
        listingName: 'Ledgerly',
        listingSlug: 'ledgerly.app',
        priceCents: 4900,
        problem: 'nofollow',
        recheckAt: '2026-10-06T09:14:00Z',
        website: 'https://ledgerly.app/'
      },
      mockup: 'badge',
      to: 'maya@quillmate.app'
    },
    {
      input: {
        checkedAt: '2026-10-05T09:14:00Z',
        listingName: 'Ledgerly',
        listingSlug: 'ledgerly.app',
        priceCents: 4900,
        problem: 'missing',
        recheckAt: '2026-10-06T09:14:00Z',
        website: 'https://ledgerly.app/'
      },
      mockup: 'badgenone',
      to: 'maya@quillmate.app'
    },
    {
      input: {
        checkedAt: '2026-10-05T09:14:00Z',
        listingName: 'Ledgerly',
        listingSlug: 'ledgerly.app',
        priceCents: 4900,
        problem: 'wrong_destination',
        recheckAt: '2026-10-06T09:14:00Z',
        website: 'https://ledgerly.app/'
      },
      mockup: 'badgewrong',
      to: 'maya@quillmate.app'
    }
  ],
  'changes-requested': [
    {
      input: {
        note: 'The short description reads like an ad (“#1 best”, “10x faster”). Describe what Pagecraft does in plain terms. Also replace the logo: the current one is a screenshot of your homepage.',
        submissionId: 's_9pd31x',
        submissionName: 'Pagecraft'
      },
      mockup: 'changes',
      to: 'maya@quillmate.app'
    }
  ],
  'claim-code': [
    {
      input: { code: '730514', listingName: 'Brieflow' },
      mockup: 'claim',
      to: 'jordan@brieflow.ai'
    }
  ],
  'draft-expired': [
    {
      input: { productName: 'Tablesmith', website: 'https://tablesmith.io' },
      mockup: 'draftexpired',
      to: 'maya@quillmate.app'
    }
  ],
  'draft-reminder': [
    {
      input: {
        expiresInDays: 29,
        lastReminder: false,
        priceCents: 4900,
        productName: 'Tablesmith',
        submissionId: 's_6tb4ws',
        variant: 'choose_plan',
        website: 'https://tablesmith.io'
      },
      mockup: 'draft12h',
      to: 'maya@quillmate.app'
    },
    {
      input: {
        expiresInDays: 9,
        lastReminder: true,
        priceCents: 4900,
        productName: 'Tablesmith',
        submissionId: 's_6tb4ws',
        variant: 'choose_plan',
        website: 'https://tablesmith.io'
      },
      mockup: 'draft21d',
      to: 'maya@quillmate.app'
    },
    {
      input: {
        expiresInDays: 23,
        lastReminder: false,
        priceCents: 4900,
        productName: 'Tablesmith',
        submissionId: 's_6tb4ws',
        variant: 'complete_checkout',
        website: 'https://tablesmith.io'
      },
      mockup: 'draftpaid',
      to: 'maya@quillmate.app'
    },
    {
      input: {
        expiresInDays: 9,
        lastReminder: true,
        priceCents: 4900,
        productName: 'Tablesmith',
        submissionId: 's_6tb4ws',
        variant: 'complete_checkout',
        website: 'https://tablesmith.io'
      },
      mockup: 'draftpaidlast',
      to: 'maya@quillmate.app'
    }
  ],
  'listing-approved': [
    {
      input: {
        listingName: 'Quillmate',
        listingSlug: 'quillmate.app',
        website: 'https://quillmate.app/'
      },
      mockup: 'approved',
      to: 'maya@quillmate.app'
    }
  ],
  'listing-live-paid': [
    {
      input: { listingName: 'Voxbloom', listingSlug: 'voxbloom.fm', paidCents: 4900 },
      mockup: 'approvedpaid',
      to: 'hello@voxbloom.fm'
    }
  ],
  'listing-unlisted': [
    {
      input: {
        checkedAt: '2026-09-30T10:02:00Z',
        listingName: 'Scrapebird',
        listingSlug: 'scrapebird.dev',
        priceCents: 4900,
        warnedAt: '2026-09-29T10:02:00Z',
        website: 'https://scrapebird.dev/'
      },
      mockup: 'unlisted',
      to: 'maya@quillmate.app'
    }
  ],
  'new-message': [
    {
      input: { about: 'Pagecraft', threadId: 't_8k2p' },
      mockup: 'newmessage',
      to: 'maya@quillmate.app'
    }
  ],
  'payment-received-in-review': [
    {
      input: {
        checkProblem: 'the connection timed out',
        paidCents: 4900,
        submissionId: 's_7tq20z',
        submissionName: 'Kiddo Tutor',
        website: 'https://kiddotutor.com/'
      },
      mockup: 'paymentreview',
      to: 'team@kiddotutor.com'
    }
  ],
  'ownership-removed': [
    {
      input: {
        checkedAt: '2026-09-22T09:10:00Z',
        listingName: 'Brieflow',
        listingSlug: 'brieflow.ai',
        priceCents: 4900,
        website: 'https://brieflow.ai/'
      },
      mockup: 'ownerremoved',
      to: 'jordan@brieflow.ai'
    }
  ],
  'sign-in-code': [
    { input: { code: '481902', type: 'sign-in' }, mockup: 'signin', to: 'maya@quillmate.app' }
  ],
  'submission-received': [
    {
      input: {
        category: 'AI Copywriting',
        submissionName: 'Quillmate',
        website: 'https://quillmate.app/'
      },
      mockup: 'received',
      to: 'maya@quillmate.app'
    }
  ],
  'submission-rejected': [
    {
      input: {
        reason:
          'promptdeck.io shows a domain-parking page with no product, so there’s nothing to list yet.',
        submissionId: 's_2kd81p',
        submissionName: 'Promptdeck'
      },
      mockup: 'rejected',
      to: 'maya@quillmate.app'
    }
  ],
  'submission-rejected-prohibited': [
    {
      input: {
        reason:
          'keybazaar.shop sells software license keys that the publishers haven’t authorized. Our Terms of Service prohibit this (IP infringement).',
        submissionId: 's_5hh3m0',
        submissionName: 'KeyBazaar',
        website: 'https://keybazaar.shop/'
      },
      mockup: 'rejectedprohibited',
      to: 'admin@keybazaar.shop'
    }
  ],
  'submission-rejected-refunded': [
    {
      input: {
        reason: 'kiddotutor.com still didn’t load when we reviewed it (the connection timed out).',
        refundedCents: 4900,
        submissionId: 's_7tq20z',
        submissionName: 'Kiddo Tutor'
      },
      mockup: 'rejectedpaid',
      to: 'team@kiddotutor.com'
    }
  ]
}

/** Renders a registered email exactly as the service would in an environment. */
export function renderAppEmail<K extends keyof AppEmailTemplates>(
  templateId: K,
  input: TemplateInput<AppEmailTemplates[K]>,
  options: { environment: SiteEnvironment; to: string }
): RenderedEmail {
  // Templates declare `render` as a method, so each accepts its own input type here.
  const template: EmailTemplate<unknown> = appEmailTemplates[templateId]
  const policy = resolveEmailPolicy({
    D1_RUNTIME_ENV: options.environment,
    SITE_ENVIRONMENT: options.environment
  })
  return renderEmail(template, input, emailRenderContext(policy, template, options.to, input))
}

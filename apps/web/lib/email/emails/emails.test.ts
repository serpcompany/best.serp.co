import { describe, expect, it } from 'vitest'
import type { SiteFeatures } from '../../features'
import { EMAIL_ADMIN_RECIPIENT, EMAIL_LINK_ORIGINS } from '../config'
import { type AppEmailTemplates, appEmailTemplates } from '../registry'
import {
  SIGN_IN_CODE_LENGTH,
  SIGN_IN_CODE_TEMPLATE,
  SIGN_IN_CODE_TTL_SECONDS
} from '../sign-in-code'
import { EmailTemplateError } from '../templates'
import { hostOf } from './layout'
import { EMAIL_SAMPLES, renderAppEmail } from './samples'

type TemplateId = keyof AppEmailTemplates
const ENVIRONMENTS = ['local', 'staging', 'production'] as const

function render(
  id: TemplateId,
  index = 0,
  environment: (typeof ENVIRONMENTS)[number] = 'production'
) {
  const sample = EMAIL_SAMPLES[id][index]
  if (!sample) throw new Error(`no sample ${id}[${index}]`)
  return renderAppEmail(id, sample.input as never, { environment, to: sample.to })
}

/** Today's site: no account dashboard pages (#65), no conversations (#73). */
const BEFORE: SiteFeatures = { accountDashboard: false, messages: false, orders: false }
/** Once #65 and #73 ship. */
const AFTER: SiteFeatures = { accountDashboard: true, messages: true, orders: false }

/** A sample rendered in production with the given site areas. */
function renderWith(id: TemplateId, features: SiteFeatures) {
  const sample = EMAIL_SAMPLES[id][0]
  if (!sample) throw new Error(`no sample ${id}`)
  return renderAppEmail(id, sample.input as never, {
    environment: 'production',
    features,
    to: sample.to
  })
}

/** The text body above the footer (the footer is the same in every email). */
function bodyText(email: { text: string }): string {
  return email.text.split('\n--\n')[0] ?? ''
}

function attributeUrls(html: string): string[] {
  return [...html.matchAll(/\s(?:href|src)="([^"]*)"/gu)].map(match => match[1] ?? '')
}

/**
 * The code must copy as exactly its digits from any mail client: one unbroken run in the HTML
 * code cell and the text body, with no space, NBSP, separator, per-digit element, or
 * zero-width character anywhere near it (owner bug: "482 913" did not paste into /login).
 */
function expectCopyableCode(email: { html: string; subject: string; text: string }, code: string) {
  const split = `${code.slice(0, 3)}[\\s\\u00a0\\u2009\\u202f.\\-–—]+${code.slice(3)}`
  const spaced = new RegExp(split, 'u')
  expect(email.subject.startsWith(`${code} `)).toBe(true)
  expect(email.text).toContain(`\n    ${code}\n`)
  // The code cell holds the code as its only content: no child elements, no extra characters.
  const cells = [...email.html.matchAll(/<td[^>]*>(\d[^<]*)<\/td>/gu)].map(match => match[1])
  expect(cells).toEqual([code])
  expect(email.html).toMatch(/letter-spacing:0\.3em[^"]*">\d{6}<\/td>/u)
  for (const part of [email.html, email.text, email.subject]) {
    expect(part).not.toMatch(spaced)
    expect(part).not.toMatch(/[\u200b-\u200d\u2060\ufeff\u00ad]/u)
  }
}

/** The HTML must link `url` from a real anchor, the button. */
function linksTo(html: string, url: string): boolean {
  return html.includes(`<a href="${url}"`)
}

describe('email registry', () => {
  it('registers every approved email under a stable id', () => {
    expect(Object.keys(appEmailTemplates).sort()).toEqual([
      'admin-new-message',
      'admin-review-ready',
      'badge-missing',
      'changes-requested',
      'claim-code',
      'draft-expired',
      'draft-reminder',
      'listing-approved',
      'listing-live-paid',
      'listing-unlisted',
      'new-message',
      'ownership-removed',
      'payment-received-in-review',
      'sign-in-code',
      'submission-received',
      'submission-rejected',
      'submission-rejected-prohibited',
      'submission-rejected-refunded'
    ])
    // Better Auth's OTP sender (lib/auth) enqueues this id; renaming it would resend codes.
    expect(SIGN_IN_CODE_TEMPLATE).toBe('sign-in-code')
    expect(appEmailTemplates[SIGN_IN_CODE_TEMPLATE].id).toBe(SIGN_IN_CODE_TEMPLATE)
    expect(Object.keys(EMAIL_SAMPLES).sort()).toEqual(Object.keys(appEmailTemplates).sort())
    for (const [id, template] of Object.entries(appEmailTemplates)) {
      expect(template.audience === 'admin', id).toBe(id.startsWith('admin-'))
    }
    expect(EMAIL_ADMIN_RECIPIENT).toBe('devin@serp.co')
  })
})

describe('every email in every environment', () => {
  for (const environment of ENVIRONMENTS) {
    const origin = EMAIL_LINK_ORIGINS[environment]
    it(`links only to ${environment} (${origin}), with the dashboard footer`, () => {
      for (const id of Object.keys(EMAIL_SAMPLES) as TemplateId[]) {
        EMAIL_SAMPLES[id].forEach((_sample, index) => {
          const email = render(id, index, environment)
          const label = `${id}[${index}] ${environment}`
          const urls = attributeUrls(email.html)
          expect(urls.length, label).toBeGreaterThan(1)
          for (const url of urls)
            expect(url.startsWith(`${origin}/`), `${label}: ${url}`).toBe(true)
          const dashboard = `${origin}${
            id.startsWith('admin-')
              ? '/admin/submissions/'
              : id === 'new-message'
                ? '/account/messages/t_8k2p/'
                : '/account/'
          }`
          expect(email.text, label).toContain(
            `This address isn't monitored. Reply from your dashboard: ${dashboard}`
          )
          expect(email.html, label).toContain(
            `This address isn’t monitored. Reply from your dashboard: <a href="${dashboard}"`
          )
          expect(email.text, label).toContain(`SERP Directory · ${origin}`)
          if (environment !== 'production') {
            expect(email.html, label).not.toContain('https://best.serp.co')
            expect(email.text, label).not.toContain('https://best.serp.co')
          }
          expect(email.html, label).toMatch(/^<!doctype html>/u)
          expect(email.html, label).toContain(`<title>`)
        })
      }
    })
  }
})

describe('submitter text is escaped', () => {
  const hostile = '<script>alert("x")</script> & \'Co\''
  const keep = new Set([
    'checkedAt',
    'code',
    'expiresInDays',
    'type',
    'lastReminder',
    'paidCents',
    'plan',
    'priceCents',
    'problem',
    'recheckAt',
    'refundedCents',
    'source',
    'unread',
    'variant',
    'warnedAt'
  ])

  it('in every template', () => {
    for (const id of Object.keys(EMAIL_SAMPLES) as TemplateId[]) {
      const sample = EMAIL_SAMPLES[id][0]
      if (!sample) continue
      const input = Object.fromEntries(
        Object.entries(sample.input).map(([key, value]) => [
          key,
          keep.has(key) || typeof value !== 'string'
            ? value
            : key === 'website'
              ? `https://evil.example/?q=${hostile}`
              : hostile
        ])
      )
      const email = renderAppEmail(id, input as never, { environment: 'production', to: sample.to })
      expect(email.html, id).not.toMatch(/<script/iu)
      // The sign-in code takes only digits, so it has no free text to escape.
      if (id !== 'sign-in-code') expect(email.html, id).toContain('&lt;script&gt;')
      for (const url of attributeUrls(email.html)) {
        expect(url.startsWith('https://best.serp.co/'), `${id}: ${url}`).toBe(true)
      }
    }
  })
})

describe('sign-in code', () => {
  it('puts the code in the subject and the body, and nowhere else', () => {
    const email = render('sign-in-code')
    expect(email.subject).toBe('481902 is your SERP sign-in code')
    expect(email.text).toBe(`Your sign-in code

Enter this code on best.serp.co to sign in or create your account:

    481902


It expires in 10 minutes and works once. If you didn't try to sign in, you can ignore this email.

--
SERP Directory · https://best.serp.co
This address isn't monitored. Reply from your dashboard: https://best.serp.co/account/
You're getting this because this address was entered at best.serp.co/login.`)
    expectCopyableCode(email, '481902')
    expect(email.html).toContain('>481902</td>')
    expect(email.html).toContain('It expires in 10 minutes and works once.')
    expect(email.html).toContain(
      'You’re getting this because this address was entered at best.serp.co/login.'
    )
    const staging = render('sign-in-code', 0, 'staging')
    expect(staging.text).toContain(
      'Enter this code on best-serp-co-staging.serpcompany.workers.dev to sign in'
    )
  })

  it('states the lifetime Better Auth gives it, and refuses codes of another length', () => {
    // lib/auth/rate-limits.ts configures Better Auth's email OTP with these (one definition).
    expect(SIGN_IN_CODE_LENGTH).toBe(6)
    expect(SIGN_IN_CODE_TTL_SECONDS).toBe(600)
    expect(EMAIL_SAMPLES['sign-in-code'][0]?.input).toEqual({
      code: '481902',
      expiresInMinutes: SIGN_IN_CODE_TTL_SECONDS / 60
    })
    expect(render('sign-in-code').text).toContain('It expires in 10 minutes and works once.')
    const fiveMinutes = renderAppEmail(
      'sign-in-code',
      { code: '481902', expiresInMinutes: 5 },
      { environment: 'production', to: 'a@b.co' }
    )
    expect(fiveMinutes.text).toContain('It expires in 5 minutes and works once.')
    expect(fiveMinutes.html).toContain('It expires in 5 minutes.')
    for (const code of ['12345', '1234567', 'abcdef', ' 123456', '']) {
      expect(() =>
        renderAppEmail(
          'sign-in-code',
          { code, expiresInMinutes: 10 },
          { environment: 'production', to: 'a@b.co' }
        )
      ).toThrow(EmailTemplateError)
    }
    for (const expiresInMinutes of [0, -1, 1.5, 61, Number.NaN]) {
      expect(() =>
        renderAppEmail(
          'sign-in-code',
          { code: '481902', expiresInMinutes },
          { environment: 'production', to: 'a@b.co' }
        )
      ).toThrow(EmailTemplateError)
    }
  })
})

describe('submission received', () => {
  it('lists the submission and links to the dashboard', () => {
    const email = render('submission-received')
    expect(email.subject).toBe('We received Quillmate')
    expect(email.text).toBe(`Quillmate is in the review queue

Thanks for submitting Quillmate. We found the badge on https://quillmate.app/ with a dofollow link to your listing, so it's now waiting for a reviewer.
Product: Quillmate
Website: https://quillmate.app/
Category: AI Copywriting
Plan: Free (badge)
We'll email you when it's been reviewed. Meanwhile, you can add FAQs and links from your dashboard.

Open your dashboard: https://best.serp.co/account/

--
SERP Directory · https://best.serp.co
This address isn't monitored. Reply from your dashboard: https://best.serp.co/account/
You're getting this because you have an account on best.serp.co.`)
    expect(linksTo(email.html, 'https://best.serp.co/account/')).toBe(true)
    expect(email.html).toContain('>Free (badge)</td>')
  })
})

describe('changes requested', () => {
  it('quotes the reviewer note', () => {
    const email = render('changes-requested')
    expect(email.subject).toBe('Changes requested for Pagecraft')
    expect(email.text).toContain(
      "Pagecraft isn't live yet. Our reviewer left this note:\n> The short description reads like an ad (“#1 best”, “10x faster”)."
    )
    expect(email.html).toContain('font-style:italic')
  })

  it('until #65 and #73, asks to resubmit from the account area and to contact us (owner decisions)', () => {
    const email = renderWith('changes-requested', BEFORE)
    expect(bodyText(email)).toContain(
      'homepage.\nUpdate your details and resubmit from your account at https://best.serp.co/account/\n\nOpen your account: https://best.serp.co/account/\nQuestions? Contact us at https://best.serp.co/contact/'
    )
    // A changes-requested submission keeps its URL key, so `/submit/` would refuse it.
    expect(bodyText(email)).not.toMatch(/submit again|\/submit\/|dashboard|reply/iu)
    expect(linksTo(email.html, 'https://best.serp.co/account/')).toBe(true)
    expect(email.html).toContain(
      'Update your details and resubmit from your account at <a href="https://best.serp.co/account/"'
    )
    expect(email.html).toContain('Questions? Contact us at <a href="https://best.serp.co/contact/"')
    expect(email.html).toContain(
      'A reviewer left a note. Update your details and resubmit from your account when you’re ready.'
    )
    expect(email.html).not.toMatch(/\/submit\/|account\/submissions/iu)
  })

  it('with the account dashboard and conversations, asks to edit, resubmit, and reply there', () => {
    const email = renderWith('changes-requested', AFTER)
    expect(bodyText(email)).toContain(
      'Make the changes and resubmit. It goes back into the review queue.\n\nEdit and resubmit: https://best.serp.co/account/submissions/s_9pd31x/\nQuestions about the note? Reply to the reviewer in your dashboard.'
    )
    expect(linksTo(email.html, 'https://best.serp.co/account/submissions/s_9pd31x/')).toBe(true)
    expect(email.html).toContain('A reviewer left a note. Edit and resubmit when you’re ready.')
    expect(email.html).not.toMatch(/submit again|contact/iu)
  })

  it('switches each sentence on its own flag', () => {
    const dashboardOnly = bodyText(
      renderWith('changes-requested', { ...BEFORE, accountDashboard: true })
    )
    expect(dashboardOnly).toContain('Edit and resubmit: ')
    expect(dashboardOnly).toContain('Questions? Contact us at https://best.serp.co/contact/')
    const messagesOnly = bodyText(renderWith('changes-requested', { ...BEFORE, messages: true }))
    expect(messagesOnly).toContain('Open your account: https://best.serp.co/account/')
    expect(messagesOnly).toContain('Reply to the reviewer in your dashboard.')
  })

  it('keeps line breaks in a note', () => {
    const email = renderAppEmail(
      'changes-requested',
      { note: 'First.\nSecond <b>.', submissionId: 's_1', submissionName: 'X' },
      { environment: 'production', to: 'a@b.co' }
    )
    expect(email.text).toContain('> First.\n> Second <b>.')
    expect(email.html).toContain('First.<br>Second &lt;b&gt;.')
  })
})

describe('listing approved', () => {
  it('shows the listing URL and links to it', () => {
    const email = render('listing-approved')
    expect(email.subject).toBe('Quillmate is live on SERP')
    expect(email.text).toBe(`Quillmate is live

Quillmate passed review and is now listed on SERP:
https://best.serp.co/products/quillmate.app/
Keep the badge on https://quillmate.app/. We check it every week, and a free listing whose badge goes missing is removed.

View your listing: https://best.serp.co/products/quillmate.app/

--
SERP Directory · https://best.serp.co
This address isn't monitored. Reply from your dashboard: https://best.serp.co/account/
You're getting this because you have an account on best.serp.co.`)
    expect(email.html).toContain('<b>https://best.serp.co/products/quillmate.app/</b>')
    expect(linksTo(email.html, 'https://best.serp.co/products/quillmate.app/')).toBe(true)
    expect(render('listing-approved', 0, 'staging').html).toContain(
      'Your listing is published at best-serp-co-staging.serpcompany.workers.dev/products/quillmate.app/'
    )
  })
})

describe('live after payment', () => {
  it('confirms the payment and the refund promise', () => {
    const email = render('listing-live-paid')
    expect(email.subject).toBe('Voxbloom is live on SERP')
    expect(email.text).toContain(
      'Thanks for your payment of $49.00. Voxbloom passed our automatic checks and is now listed on SERP:\nhttps://best.serp.co/products/voxbloom.fm/'
    )
    expect(email.text).toContain('The badge is optional for paid listings.')
    expect(linksTo(email.html, 'https://best.serp.co/products/voxbloom.fm/')).toBe(true)
  })
})

describe('rejected', () => {
  it('gives the reason', () => {
    const email = render('submission-rejected')
    expect(email.subject).toBe('Promptdeck wasn’t approved')
    expect(email.text).toContain(
      "A reviewer looked at Promptdeck and couldn't approve it this time.\nReason: promptdeck.io shows a domain-parking page with no product, so there's nothing to list yet."
    )
    expect(email.html).toContain('<b>Reason:</b> promptdeck.io shows')
  })

  it('until #65, asks to submit again at /submit/ (owner decision)', () => {
    const email = renderWith('submission-rejected', BEFORE)
    expect(bodyText(email)).toContain(
      'nothing to list yet.\nUpdate your details and submit again at https://best.serp.co/submit/\n\nSubmit again: https://best.serp.co/submit/'
    )
    expect(bodyText(email)).not.toMatch(/edit the submission|open submission|dashboard/iu)
    expect(linksTo(email.html, 'https://best.serp.co/submit/')).toBe(true)
    expect(email.html).not.toContain('account/submissions')
  })

  it('with the account dashboard, asks to edit the submission and links to it', () => {
    const email = renderWith('submission-rejected', AFTER)
    expect(bodyText(email)).toContain(
      'nothing to list yet.\nYou can edit the submission and send it again.\n\nOpen submission: https://best.serp.co/account/submissions/s_2kd81p/'
    )
    expect(linksTo(email.html, 'https://best.serp.co/account/submissions/s_2kd81p/')).toBe(true)
    expect(email.html).not.toMatch(/submit again/iu)
  })

  it('says how much was refunded', () => {
    const email = render('submission-rejected-refunded')
    expect(email.subject).toBe('Kiddo Tutor wasn’t approved, and we’ve refunded you')
    expect(email.text).toContain(
      "We've refunded $49.00 to your original payment method. It can take 5 to 10 business days to show up."
    )
    expect(email.html).toContain('We’ve refunded <b>$49.00</b> to your original payment method.')
    expect(email.html).toContain('Your $49.00 payment has been refunded.')
    expect(linksTo(email.html, 'https://best.serp.co/account/')).toBe(true)
  })
})

describe('badge missing', () => {
  it('gives the check and recheck times in UTC and links to the listing', () => {
    const email = render('badge-missing')
    expect(email.subject).toBe('Action needed: the SERP badge is missing on ledgerly.app')
    expect(email.text).toContain(
      "Our weekly check loaded https://ledgerly.app/ on Mon, Oct 5 at 09:14 UTC. The badge is there, but its link is marked nofollow.\nWe'll check again around Tue, Oct 6 at 09:14 UTC. If there still isn't a badge with a dofollow link to your listing, Ledgerly will be removed from SERP."
    )
    expect(email.text).toContain(
      'Check my badge: https://best.serp.co/account/listings/ledgerly.app/\nRather not keep the badge? Upgrade to a paid listing for $49 one-off and the badge becomes optional.'
    )
    expect(email.html).toContain('its link is marked <b>nofollow</b>.')
    expect(email.html).toContain('<b>Tue, Oct 6 at 09:14 UTC</b>')
    expect(linksTo(email.html, 'https://best.serp.co/account/listings/ledgerly.app/')).toBe(true)
  })

  it('names what the check found', () => {
    const sample = EMAIL_SAMPLES['badge-missing'][0]
    if (!sample) throw new Error('sample')
    const text = (problem: 'missing' | 'nofollow' | 'wrong_destination') =>
      renderAppEmail(
        'badge-missing',
        { ...sample.input, problem },
        {
          environment: 'production',
          to: sample.to
        }
      ).text
    expect(text('missing')).toContain("09:14 UTC. We couldn't find the badge on the page.")
    expect(text('wrong_destination')).toContain(
      "The badge is there, but its link doesn't point to your listing."
    )
  })
})

describe('unlisted', () => {
  it('says when it was removed and offers the paid relisting', () => {
    const email = render('listing-unlisted')
    expect(email.subject).toBe('Scrapebird has been removed from SERP')
    expect(email.text).toContain(
      'We rechecked https://scrapebird.dev/ on Wed, Sep 30 at 10:02 UTC and the badge was still missing, so Scrapebird has been removed from SERP, as we warned on Tue, Sep 29.'
    )
    expect(email.text).toContain(
      'Relist for $49: https://best.serp.co/account/listings/scrapebird.dev/'
    )
    expect(linksTo(email.html, 'https://best.serp.co/account/listings/scrapebird.dev/')).toBe(true)
  })
})

describe('claim code', () => {
  it('puts the code in the subject', () => {
    const email = render('claim-code')
    expect(email.subject).toBe('730514 is your SERP code to claim Brieflow')
    expect(email.text).toContain('Enter this code to confirm:\n\n    730514\n')
    expect(email.text).toContain(
      "You're getting this because this address was entered to claim a listing on best.serp.co."
    )
    expectCopyableCode(email, '730514')
    expect(email.html).toContain('>730514</td>')
  })
})

describe('admin: ready for review', () => {
  it('lists the submission, links to the admin review, and names the recipient', () => {
    const email = render('admin-review-ready')
    expect(email.subject).toBe('Ready for review: Quillmate (free, badge verified)')
    expect(email.text).toBe(`Quillmate is ready for review

Product: Quillmate
Website: https://quillmate.app/
Category: AI Copywriting
Source: New submission
Plan: Free. Badge verified Tue, Oct 6, 10:42 UTC
Submitted by: maya@quillmate.app

Review submission: https://best.serp.co/admin/submissions/s_4f9k2c/

--
SERP Directory · https://best.serp.co
This address isn't monitored. Reply from your dashboard: https://best.serp.co/admin/submissions/
You're getting this because devin@serp.co receives review alerts for best.serp.co.`)
    expect(linksTo(email.html, 'https://best.serp.co/admin/submissions/s_4f9k2c/')).toBe(true)
  })

  it('labels paid submissions in the subject', () => {
    const sample = EMAIL_SAMPLES['admin-review-ready'][0]
    if (!sample) throw new Error('sample')
    const subject = (plan: { kind: 'paid'; live: boolean }, source: 'revision' | 'submission') =>
      renderAppEmail(
        'admin-review-ready',
        { ...sample.input, plan, source },
        {
          environment: 'production',
          to: sample.to
        }
      )
    const live = subject({ kind: 'paid', live: true }, 'submission')
    expect(live.subject).toBe('Ready for review: Quillmate (paid, live now)')
    expect(live.text).toContain('Plan: Paid. Live now')
    const waiting = subject({ kind: 'paid', live: false }, 'revision')
    expect(waiting.subject).toBe('Ready for review: Quillmate (paid, waiting for review)')
    expect(waiting.text).toContain('Source: Revision')
  })
})

describe('ownership removed', () => {
  it('explains the removal and links to the listing to claim again', () => {
    const email = render('ownership-removed')
    expect(email.subject).toBe('You no longer manage Brieflow on SERP')
    expect(email.text).toContain(
      'We rechecked https://brieflow.ai/ on Tue, Sep 22 at 09:10 UTC and the badge was still missing. Ownership came from the badge, so you no longer manage the Brieflow listing.'
    )
    expect(email.text).toContain('Claim Brieflow again: https://best.serp.co/products/brieflow.ai/')
    expect(linksTo(email.html, 'https://best.serp.co/products/brieflow.ai/')).toBe(true)
  })
})

describe('new message', () => {
  it('links to the conversation without the message', () => {
    const email = render('new-message')
    expect(email.subject).toBe('You have a new message about Pagecraft')
    expect(email.text).toContain(
      'The SERP team replied to your conversation about Pagecraft. Open it in your dashboard to read it and reply.'
    )
    expect(email.html).toContain('your conversation about <b>Pagecraft</b>.')
    expect(linksTo(email.html, 'https://best.serp.co/account/messages/t_8k2p/')).toBe(true)
  })
})

describe('admin: new message', () => {
  it('names the sender and links to the inbox thread, without the message', () => {
    const email = render('admin-new-message')
    expect(email.subject).toBe('New message from brieflow.ai: Brieflow claim')
    expect(email.text).toContain(
      'From: priya@brieflow.ai\nAbout: Claim: Brieflow (brieflow.ai)\nUnread: 1 message'
    )
    expect(email.html).toContain('Claim · 1 unread message')
    expect(email.text).toContain(
      "You're getting this because devin@serp.co receives inbox alerts for best.serp.co."
    )
    expect(linksTo(email.html, 'https://best.serp.co/admin/inbox/t_3hq7/')).toBe(true)
    const many = renderAppEmail(
      'admin-new-message',
      { ...(EMAIL_SAMPLES['admin-new-message'][0]?.input as never), unread: 3 },
      { environment: 'production', to: 'devin@serp.co' }
    )
    expect(many.text).toContain('Unread: 3 messages')
  })
})

describe('draft reminder', () => {
  it('asks to choose a plan, with the days left', () => {
    const email = render('draft-reminder', 0)
    expect(email.subject).toBe('Finish your submission: Tablesmith')
    expect(email.text).toContain(
      "Your draft for Tablesmith expires in 29 days.\nIt's saved with everything you entered. Pick how to get listed: free with our badge, or $49 one-off without it. Nothing is reviewed until you choose."
    )
    expect(email.html).toContain('Your draft for <b>Tablesmith</b> expires in 29 days.')
    expect(linksTo(email.html, 'https://best.serp.co/submit/s_6tb4ws/choose/')).toBe(true)
  })

  it('labels the +21d reminder as the last one', () => {
    const email = render('draft-reminder', 1)
    expect(email.subject).toBe('Last reminder: your Tablesmith draft expires in 9 days')
    expect(email.text).toContain(
      'This is the last reminder. After that the draft is deleted and tablesmith.io can be submitted by anyone. Pick how to get listed: free with our badge, or $49 one-off without it.'
    )
  })

  it('asks to complete checkout when the paid listing was chosen', () => {
    const email = render('draft-reminder', 2)
    expect(email.subject).toBe('Finish your submission: Tablesmith')
    expect(email.text).toContain(
      "You picked the paid listing but didn't finish checkout, so you haven't been charged. Complete the $49 one-off payment and Tablesmith goes live as soon as our automatic checks pass. A reviewer still looks at it."
    )
    expect(email.text).toContain(
      'Complete checkout: https://best.serp.co/submit/s_6tb4ws/checkout/\nRather add our badge instead? You can still switch to the free option from the same page.'
    )
    expect(linksTo(email.html, 'https://best.serp.co/submit/s_6tb4ws/checkout/')).toBe(true)
    const last = renderAppEmail(
      'draft-reminder',
      {
        ...(EMAIL_SAMPLES['draft-reminder'][2]?.input as never),
        expiresInDays: 1,
        lastReminder: true
      },
      { environment: 'production', to: 'a@b.co' }
    )
    expect(last.subject).toBe('Last reminder: your Tablesmith draft expires in 1 day')
    expect(last.text).toContain(
      'This is the last reminder. After that the draft is deleted and tablesmith.io can be submitted by anyone. You picked the paid listing'
    )
  })
})

describe('draft expired', () => {
  it('says the URL is released and links to a prefilled new submission', () => {
    const email = render('draft-expired')
    expect(email.subject).toBe('Your Tablesmith draft expired')
    expect(email.text).toContain(
      'Your draft for Tablesmith expired 30 days after it was saved, so it has been removed.\nThe URL tablesmith.io is released, so it can be submitted again.'
    )
    expect(
      linksTo(email.html, 'https://best.serp.co/submit/?url=https%3A%2F%2Ftablesmith.io')
    ).toBe(true)
  })
})

describe('revision 5 emails', () => {
  it('rejected as prohibited: no resubmission, no refund, Message us', () => {
    const email = renderWith('submission-rejected-prohibited', BEFORE)
    expect(email.subject).toBe('KeyBazaar wasn’t approved')
    expect(email.text).toBe(`KeyBazaar wasn’t approved

A reviewer looked at KeyBazaar and couldn't approve it.
Reason: keybazaar.shop sells software license keys that the publishers haven't authorized. Our Terms of Service prohibit this (IP infringement).
Because the content is prohibited, keybazaar.shop can't be submitted or claimed again. If you think this is a mistake, message us.

Message us: https://best.serp.co/contact/

--
SERP Directory · https://best.serp.co
This address isn't monitored. Reply from your dashboard: https://best.serp.co/account/
You're getting this because you have an account on best.serp.co.`)
    expect(email.html).toContain('keybazaar.shop can’t be submitted again.')
    expect(email.text).not.toMatch(/refund|send it again/iu)
    // The account inbox arrives with #73; until then "Message us" opens the contact page.
    expect(linksTo(email.html, 'https://best.serp.co/contact/')).toBe(true)
  })

  it('rejected as prohibited, with conversations: message us from the dashboard', () => {
    const email = renderWith('submission-rejected-prohibited', AFTER)
    expect(bodyText(email)).toContain(
      "can't be submitted or claimed again. If you think this is a mistake, message us from your dashboard.\n\nMessage us: https://best.serp.co/account/messages/new/?about=submission:s_5hh3m0"
    )
    expect(
      linksTo(email.html, 'https://best.serp.co/account/messages/new/?about=submission:s_5hh3m0')
    ).toBe(true)
  })

  it('payment received while the checks failed: not live yet, in review', () => {
    const email = render('payment-received-in-review')
    expect(email.subject).toBe('Payment received: Kiddo Tutor is in review')
    expect(email.text).toBe(`Kiddo Tutor goes live after review

Thanks for your payment of $49.00.
Our automatic checks couldn't load https://kiddotutor.com/ (the connection timed out), so Kiddo Tutor isn't live yet. A reviewer will look at it before it's published. You don't need to do anything.
If it's rejected for anything other than prohibited content, you get a full refund automatically.

View submission: https://best.serp.co/account/

--
SERP Directory · https://best.serp.co
This address isn't monitored. Reply from your dashboard: https://best.serp.co/account/
You're getting this because you have an account on best.serp.co.`)
    expect(email.html).toContain('Kiddo Tutor goes live after a reviewer looks at it.')
  })

  it('badge missing: the not-on-page and wrong-destination findings', () => {
    expect(render('badge-missing', 1).text).toContain(
      "Our weekly check loaded https://ledgerly.app/ on Mon, Oct 5 at 09:14 UTC. We couldn't find the badge on the page."
    )
    expect(render('badge-missing', 2).text).toContain(
      "Our weekly check loaded https://ledgerly.app/ on Mon, Oct 5 at 09:14 UTC. The badge is there, but its link doesn't point to your listing."
    )
  })

  it('admin review alert: the paid variants', () => {
    const waiting = render('admin-review-ready', 1)
    expect(waiting.subject).toBe('Ready for review: Kiddo Tutor (paid, waiting for review)')
    expect(waiting.text).toContain(
      'Source: New submission\nPlan: Paid. Waiting for review\nSubmitted by: team@kiddotutor.com'
    )
    expect(waiting.html).toContain('AI Tutor · submitted by team@kiddotutor.com')
    const live = render('admin-review-ready', 2)
    expect(live.subject).toBe('Ready for review: Voxbloom (paid, live now)')
    expect(live.text).toContain('Plan: Paid. Live now')
    expect(linksTo(live.html, 'https://best.serp.co/admin/submissions/s_8m2q1d/')).toBe(true)
  })

  it('the last complete-checkout reminder', () => {
    const email = render('draft-reminder', 3)
    expect(email.subject).toBe('Last reminder: your Tablesmith draft expires in 9 days')
    expect(email.text).toContain(
      "Your draft for Tablesmith expires in 9 days.\nThis is the last reminder. After that the draft is deleted and tablesmith.io can be submitted by anyone. You picked the paid listing but didn't finish checkout, so you haven't been charged. Complete the $49 one-off payment and Tablesmith goes live as soon as our automatic checks pass. A reviewer still looks at it."
    )
    expect(linksTo(email.html, 'https://best.serp.co/submit/s_6tb4ws/checkout/')).toBe(true)
  })
})

describe('robustness', () => {
  const longName = `${'Very long product name '.repeat(12)}end`

  it('shortens long names in subjects instead of dropping the email', () => {
    for (const id of Object.keys(EMAIL_SAMPLES) as TemplateId[]) {
      const sample = EMAIL_SAMPLES[id][0]
      if (!sample) continue
      const input = Object.fromEntries(
        Object.entries(sample.input).map(([key, value]) => [
          key,
          /name$|^about$|^topic$/iu.test(key) && typeof value === 'string' ? longName : value
        ])
      )
      const email = renderAppEmail(id, input as never, { environment: 'production', to: sample.to })
      expect(email.subject.length, id).toBeLessThanOrEqual(200)
      if (id !== 'sign-in-code' && id !== 'badge-missing') expect(email.subject, id).toContain('…')
    }
    const admin = renderAppEmail(
      'admin-review-ready',
      { ...(EMAIL_SAMPLES['admin-review-ready'][1]?.input as never), submissionName: longName },
      { environment: 'production', to: 'devin@serp.co' }
    )
    // The plan stays readable after a shortened name.
    expect(admin.subject).toMatch(/…\s?\(paid, waiting for review\)$/u)
  })

  it('never puts a submitter address in the admin message subject', () => {
    const sample = EMAIL_SAMPLES['admin-new-message'][0]
    if (!sample) throw new Error('sample')
    expect(render('admin-new-message').subject).toBe('New message from brieflow.ai: Brieflow claim')
    const named = renderAppEmail(
      'admin-new-message',
      { ...sample.input, fromName: 'Priya Shah' },
      { environment: 'production', to: 'devin@serp.co' }
    )
    expect(named.subject).toBe('New message from Priya Shah: Brieflow claim')
    expect(named.subject).not.toContain('@')
    expect(named.text).toContain('From: priya@brieflow.ai')
  })

  it('accepts only http(s) websites', () => {
    expect(hostOf('https://ledgerly.app/')).toBe('ledgerly.app')
    expect(hostOf('http://ledgerly.app:8080/x')).toBe('ledgerly.app:8080')
    for (const url of [
      'javascript:alert(1)',
      'mailto:a@b.co',
      'ftp://x.example/',
      'ledgerly.app',
      ''
    ]) {
      expect(() => hostOf(url), url).toThrow(EmailTemplateError)
    }
  })
})

describe('Outlook', () => {
  it('pads the button cell and fixes the column width', () => {
    const email = render('submission-received')
    // Outlook ignores padding on links and max-width on tables.
    expect(email.html).toContain(
      '<td bgcolor="#09090b" style="background-color:#09090b;padding:12px 24px"><a href="https://best.serp.co/account/"'
    )
    expect(email.html).not.toMatch(/<a href="[^"]+" style="[^"]*padding/u)
    expect(email.html).toContain(
      '<!--[if mso]><table role="presentation" width="640" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->'
    )
    expect(email.html).toContain('<!--[if mso]></td></tr></table><![endif]-->')
  })
})

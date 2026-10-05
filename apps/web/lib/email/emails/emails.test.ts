import { describe, expect, it } from 'vitest'
import { EMAIL_ADMIN_RECIPIENT, EMAIL_LINK_ORIGINS } from '../config'
import { type AppEmailTemplates, appEmailTemplates, SIGN_IN_CODE_TEMPLATE } from '../registry'
import { EmailTemplateError } from '../templates'
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

function attributeUrls(html: string): string[] {
  return [...html.matchAll(/\s(?:href|src)="([^"]*)"/gu)].map(match => match[1] ?? '')
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
      'sign-in-code',
      'submission-received',
      'submission-rejected',
      'submission-rejected-refunded'
    ])
    // Better Auth's OTP sender (#72) enqueues this id; renaming it would break that wiring.
    expect(SIGN_IN_CODE_TEMPLATE).toBe('sign-in-code')
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
          const dashboard = `${origin}${id.startsWith('admin-') ? '/admin/' : '/account/'}`
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
    'expiresInMinutes',
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
    expect(email.html).toContain('>481 902</td>')
    expect(email.html).toContain('It expires in 10 minutes and works once.')
    expect(email.html).toContain(
      'You’re getting this because this address was entered at best.serp.co/login.'
    )
    const staging = render('sign-in-code', 0, 'staging')
    expect(staging.text).toContain(
      'Enter this code on best-serp-co-staging.serpcompany.workers.dev to sign in'
    )
  })

  it('takes the configured lifetime and refuses anything but six digits', () => {
    const email = renderAppEmail(
      'sign-in-code',
      { code: '000123', expiresInMinutes: 5 },
      { environment: 'production', to: 'a@b.co' }
    )
    expect(email.text).toContain('It expires in 5 minutes and works once.')
    for (const code of ['12345', '1234567', 'abcdef', ' 123456', '']) {
      expect(() =>
        renderAppEmail('sign-in-code', { code }, { environment: 'production', to: 'a@b.co' })
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
  it('quotes the reviewer note and links to the submission', () => {
    const email = render('changes-requested')
    expect(email.subject).toBe('Changes requested for Pagecraft')
    expect(email.text).toContain(
      "Pagecraft isn't live yet. Our reviewer left this note:\n> The short description reads like an ad (“#1 best”, “10x faster”)."
    )
    expect(email.text).toContain(
      'Edit and resubmit: https://best.serp.co/account/submissions/s_9pd31x/\nQuestions about the note? Reply to the reviewer in your dashboard.'
    )
    expect(linksTo(email.html, 'https://best.serp.co/account/submissions/s_9pd31x/')).toBe(true)
    expect(email.html).toContain('font-style:italic')
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
  it('gives the reason and links to the submission', () => {
    const email = render('submission-rejected')
    expect(email.subject).toBe('Promptdeck wasn’t approved')
    expect(email.text).toContain(
      "A reviewer looked at Promptdeck and couldn't approve it this time.\nReason: promptdeck.io shows a domain-parking page with no product, so there's nothing to list yet.\nYou can edit the submission and send it again."
    )
    expect(email.html).toContain('<b>Reason:</b> promptdeck.io shows')
    expect(linksTo(email.html, 'https://best.serp.co/account/submissions/s_2kd81p/')).toBe(true)
  })

  it('says how much was refunded', () => {
    const email = render('submission-rejected-refunded')
    expect(email.subject).toBe('Kiddo Tutor wasn’t approved, and we’ve refunded you')
    expect(email.text).toContain(
      "We've refunded $49.00 to your original payment method. It can take 5 to 10 business days to show up."
    )
    expect(email.html).toContain('We’ve refunded <b>$49.00</b> to your original payment method.')
    expect(email.html).toContain('Your $49.00 payment has been refunded.')
    expect(linksTo(email.html, 'https://best.serp.co/account/submissions/s_7tq20z/')).toBe(true)
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
    expect(email.html).toContain('>730 514</td>')
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
This address isn't monitored. Reply from your dashboard: https://best.serp.co/admin/
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
    expect(email.subject).toBe('New message from priya@brieflow.ai: Brieflow claim')
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
      'Your draft for Tablesmith was saved 30 days ago without a plan, so it has expired and been removed.\nThe URL tablesmith.io is released, so it can be submitted again.'
    )
    expect(
      linksTo(email.html, 'https://best.serp.co/submit/?url=https%3A%2F%2Ftablesmith.io')
    ).toBe(true)
  })
})

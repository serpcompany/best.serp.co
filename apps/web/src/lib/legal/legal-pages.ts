import { getRoute } from '../routing/routes'

/** A page under /legal/: its route, title, description, and its `content/legal/` file. */
export type LegalPage = {
  contentKey: string
  /** `{{SITE_NAME}}` stands for the site's name. */
  description: string
  path: string
  title: string
}

/** The legal pages, in the footer's order with the cookie policy after the terms (#276). */
export const legalPages = [
  {
    contentKey: 'privacy',
    description:
      'Privacy policy for {{SITE_NAME}}. Learn how we collect, use, and protect your information.',
    path: getRoute('privacy'),
    title: 'Privacy Policy'
  },
  {
    contentKey: 'terms',
    description:
      'Terms of service for {{SITE_NAME}}. Read our terms and conditions for using this service.',
    path: getRoute('terms'),
    title: 'Terms of Service'
  },
  {
    contentKey: 'cookies',
    description:
      'Cookie policy for {{SITE_NAME}}. Learn how we use cookies and similar technologies.',
    path: getRoute('cookies'),
    title: 'Cookie Policy'
  },
  {
    contentKey: 'affiliate-disclosure',
    description:
      'Affiliate disclosure for {{SITE_NAME}}. Learn how this site handles affiliate relationships and compensation.',
    path: getRoute('affiliateDisclosure'),
    title: 'Affiliate Disclosure'
  },
  {
    contentKey: 'dmca',
    description:
      'DMCA policy for {{SITE_NAME}}. Learn how to submit copyright and intellectual property complaints.',
    path: getRoute('dmca'),
    title: 'DMCA'
  }
] as const satisfies readonly LegalPage[]

export type LegalPagePath = (typeof legalPages)[number]['path']

export function legalPageFor(path: LegalPagePath): LegalPage {
  const page = legalPages.find(entry => entry.path === path)
  if (!page) throw new Error(`No legal page at ${path}`)
  return page
}

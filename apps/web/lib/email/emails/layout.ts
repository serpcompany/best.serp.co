/**
 * The shared layout of every best.serp.co email, built to the mockups approved in
 * serpcompany/best.serp.co#70 (screen 15): the SERP mark, a heading, body blocks, an optional
 * code and button, and the footer that says the address isn't monitored and links to the
 * dashboard. It renders the HTML part (email-safe tables, inline styles through `css()`, a
 * table-based button) and the plain-text part from one description, so the two never drift.
 */
import { type SiteFeatures, features as siteFeatures } from '../../features'
import {
  css,
  type EmailContent,
  type EmailRenderContext,
  EmailTemplateError,
  type HtmlValue,
  html,
  type SafeHtml
} from '../templates'

/** Design tokens from the approved mockups (zinc palette, the site's type). */
export const EMAIL_TOKENS = {
  font: "'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  ink: '#09090b',
  line: '#e4e4e7',
  mono: "'Geist Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  muted: '#71717a',
  page: '#f4f4f5',
  panel: '#fafafa',
  quoteLine: '#d4d4d8',
  strong: '#3f3f46',
  surface: '#ffffff',
  text: '#18181b'
} as const

const T = EMAIL_TOKENS

/** Inline text: plain strings and numbers, a bold run, or a link that shows its URL. */
export type Inline =
  | string
  | number
  | { readonly bold: string | number }
  | { readonly link: string }

export function bold(value: string | number): { readonly bold: string | number } {
  return { bold: value }
}

/** An absolute URL written out as a link (`links.url(...)`), the same in both bodies. */
export function link(url: string): { readonly link: string } {
  return { link: url }
}

export type Block =
  | { readonly kind: 'paragraph'; readonly content: readonly Inline[] }
  | { readonly kind: 'quote'; readonly text: string }
  | { readonly kind: 'box'; readonly content: readonly Inline[] }
  | { readonly kind: 'rows'; readonly rows: ReadonlyArray<readonly [string, string]> }

export const paragraph = (...content: Inline[]): Block => ({ content, kind: 'paragraph' })
export const quote = (text: string): Block => ({ kind: 'quote', text })
export const box = (...content: Inline[]): Block => ({ content, kind: 'box' })
export const rows = (entries: ReadonlyArray<readonly [string, string]>): Block => ({
  kind: 'rows',
  rows: entries
})

export interface EmailLayout {
  /** Sentences after the button or code. */
  after?: readonly Block[]
  body: readonly Block[]
  /**
   * A one-time code, shown large. It is rendered as one unbroken run of digits, spaced only by
   * CSS `letter-spacing`, so copying it from any mail client yields exactly the code.
   */
  code?: string
  cta?: { label: string; url: string }
  heading: string
  /** The inbox preview line. */
  preheader: string
  /** "You're getting this because …" (defaults to having an account). */
  reason?: string
  subject: string
}

/** Plain text uses straight apostrophes, as the approved plain-text parts do. */
function plain(text: string): string {
  return text.replace(/’/gu, "'")
}

function inlineText(content: readonly Inline[]): string {
  return plain(
    content
      .map(part =>
        typeof part !== 'object' ? String(part) : 'link' in part ? part.link : String(part.bold)
      )
      .join('')
  )
}

const inlineLinkStyle = css({
  color: T.strong,
  'text-decoration': 'underline',
  'word-break': 'break-all'
})

function inlineHtml(content: readonly Inline[]): HtmlValue[] {
  return content.map(part => {
    if (typeof part !== 'object') return String(part)
    return 'link' in part
      ? html`<a href="${part.link}" style="${inlineLinkStyle}">${part.link}</a>`
      : html`<b>${String(part.bold)}</b>`
  })
}

function lines(text: string): HtmlValue[] {
  return text.split(/\r?\n/u).map((line, index) => (index === 0 ? line : [html`<br>`, line]))
}

const paragraphStyle = css({
  'font-size': '15px',
  'line-height': '28px',
  margin: '16px 0 0 0'
})

function blockHtml(block: Block): SafeHtml {
  switch (block.kind) {
    case 'paragraph':
      return html`<p style="${paragraphStyle}">${inlineHtml(block.content)}</p>`
    case 'quote':
      return html`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="${css({ 'border-collapse': 'collapse', 'margin-top': '16px' })}"><tr><td bgcolor="${T.panel}" style="${css({ 'background-color': T.panel, 'border-left': `4px solid ${T.quoteLine}`, 'font-size': '15px', 'font-style': 'italic', 'line-height': '28px', padding: '12px 12px 12px 16px' })}">${lines(block.text)}</td></tr></table>`
    case 'box':
      return html`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="${css({ 'border-collapse': 'separate', 'margin-top': '20px' })}"><tr><td bgcolor="${T.panel}" style="${css({ 'background-color': T.panel, border: `1px solid ${T.line}`, 'border-radius': '6px', 'font-size': '14px', 'line-height': '22px', padding: '16px', 'word-break': 'break-word' })}">${inlineHtml(block.content)}</td></tr></table>`
    case 'rows':
      return html`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="${css({ 'border-collapse': 'collapse', 'font-size': '14px', 'line-height': '20px', 'margin-top': '20px' })}">${block.rows.map(
        ([label, value]) =>
          html`<tr><td valign="top" style="${css({ 'border-bottom': `1px solid ${T.line}`, color: T.muted, padding: '8px 12px 8px 0', 'vertical-align': 'top', width: '144px' })}">${label}</td><td style="${css({ 'border-bottom': `1px solid ${T.line}`, 'font-weight': '500', padding: '8px 0', 'word-break': 'break-all' })}">${value}</td></tr>`
      )}</table>`
  }
}

function blockText(block: Block): string {
  switch (block.kind) {
    case 'paragraph':
    case 'box':
      return inlineText(block.content)
    case 'quote':
      return plain(
        block.text
          .split(/\r?\n/u)
          .map(line => `> ${line}`)
          .join('\n')
      )
    case 'rows':
      return plain(block.rows.map(([label, value]) => `${label}: ${value}`).join('\n'))
  }
}

/** The host of a URL, for subjects and labels (`https://ledgerly.app/` → `ledgerly.app`). */
export function hostOf(url: string): string {
  let parsed: URL | null = null
  try {
    parsed = new URL(url)
  } catch {
    parsed = null
  }
  if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || !parsed.host) {
    throw new EmailTemplateError('Expected an absolute http(s) website URL.')
  }
  return parsed.host
}

/** Submitter-supplied names in subjects are cut to this many characters (with an ellipsis). */
export const SUBJECT_NAME_MAX = 80

function asDate(value: Date | string): Date {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) throw new EmailTemplateError('Expected a valid date.')
  return date
}

const DAY = new Intl.DateTimeFormat('en-US', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
  weekday: 'short'
})
const TIME = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  hour12: false,
  minute: '2-digit',
  timeZone: 'UTC'
})

/** `Tue, Sep 29` in UTC. */
export function formatDay(value: Date | string): string {
  return DAY.format(asDate(value))
}

/** `Mon, Oct 5 at 09:14 UTC`. */
export function formatCheckTime(value: Date | string): string {
  const date = asDate(value)
  return `${DAY.format(date)} at ${TIME.format(date)} UTC`
}

/** `Tue, Oct 6, 10:42 UTC`. */
export function formatStamp(value: Date | string): string {
  const date = asDate(value)
  return `${DAY.format(date)}, ${TIME.format(date)} UTC`
}

/** `$49.00` with cents, `$49` without (whole dollars only). */
export function formatUsd(cents: number, options: { cents: boolean }): string {
  if (!Number.isInteger(cents) || cents < 0) throw new EmailTemplateError('Expected a price.')
  const dollars = Math.floor(cents / 100)
  const rest = String(cents % 100).padStart(2, '0')
  return options.cents || rest !== '00' ? `$${dollars}.${rest}` : `$${dollars}`
}

/** `1 day`, `9 days`. */
export function days(count: number): string {
  if (!Number.isInteger(count) || count < 0) throw new EmailTemplateError('Expected a day count.')
  return `${count} day${count === 1 ? '' : 's'}`
}

/** A non-empty string input, trimmed. */
export function required(value: string, label: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (!trimmed) throw new EmailTemplateError(`The email needs ${label}.`)
  return trimmed
}

/** A root-relative path with each segment encoded: `sitePath('submit', id, 'choose')`. */
export function sitePath(...segments: string[]): string {
  return `/${segments.map(segment => encodeURIComponent(required(segment, 'a link segment'))).join('/')}/`
}

/** The site areas this email renders for: the context's flags, else the site's. */
export function featuresOf(context: EmailRenderContext): SiteFeatures {
  return context.features ?? siteFeatures
}

/** Where to submit a product again while the account dashboard can't edit one (#65). */
export const SUBMIT_PATH = '/submit/'

/** Where to reach the team while there are no conversations (#73). */
export const CONTACT_PATH = '/contact/'

/**
 * A submission's own page (`/account/submissions/<id>/`) once #65 ships it, and the account
 * dashboard until then. Emails link only to pages that exist (`links.test.ts`).
 */
export function submissionPath(submissionId: string, context: EmailRenderContext): string {
  return featuresOf(context).accountDashboard
    ? sitePath('account', 'submissions', submissionId)
    : '/account/'
}

/**
 * "Message us" about a submission: a new conversation once #73 ships, and the contact page
 * until then.
 */
export function messageUsPath(submissionId: string, context: EmailRenderContext): string {
  return featuresOf(context).messages
    ? `/account/messages/new/?about=submission:${encodeURIComponent(submissionId)}`
    : CONTACT_PATH
}

/**
 * The code block. The code is one text node with no space, separator, per-digit element, or
 * zero-width character: the mockup's spacing comes from `letter-spacing` alone, so selecting
 * and copying it (Gmail, Apple Mail, Outlook) gives the bare digits the code field accepts.
 */
function codeHtml(code: string): SafeHtml {
  return html`<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="${css({ 'border-collapse': 'separate', 'margin-top': '24px' })}"><tr><td bgcolor="${T.panel}" style="${css({ 'background-color': T.panel, border: `1px solid ${T.line}`, 'border-radius': '6px', 'font-family': T.mono, 'font-size': '30px', 'font-weight': '600', 'letter-spacing': '0.3em', 'line-height': '36px', padding: '16px 24px' })}">${code}</td></tr></table>`
}

function ctaHtml(cta: { label: string; url: string }): SafeHtml {
  // Padding sits on the cell: Outlook's Word engine ignores padding on links.
  return html`<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="${css({ 'border-collapse': 'separate', 'margin-top': '28px' })}"><tr><td bgcolor="${T.ink}" style="${css({ 'background-color': T.ink, padding: '12px 24px' })}"><a href="${cta.url}" style="${css({ color: T.surface, display: 'inline-block', 'font-family': T.font, 'font-size': '14px', 'font-weight': '700', 'line-height': '20px', 'text-decoration': 'none' })}">${cta.label}</a></td></tr></table><p style="${css({ color: T.muted, 'font-size': '12px', 'line-height': '18px', margin: '12px 0 0 0', 'word-break': 'break-all' })}">Or open ${cta.url}</p>`
}

const DEFAULT_REASON = 'You’re getting this because you have an account on'

/**
 * The finished email: subject, plain text, and HTML, with the required footer link to
 * `context.dashboardUrl`.
 */
export function composeEmail(layout: EmailLayout, context: EmailRenderContext): EmailContent {
  const host = new URL(context.links.origin).host
  const reason = layout.reason ?? `${DEFAULT_REASON} ${host}.`
  const dashboard = context.dashboardUrl
  const after = layout.after ?? []

  const text = [
    layout.heading,
    '',
    ...layout.body.map(blockText),
    layout.code ? `\n    ${layout.code}\n` : '',
    layout.cta ? `${plain(layout.cta.label)}: ${layout.cta.url}` : '',
    ...after.map(blockText),
    '',
    '--',
    `SERP Directory · ${context.links.origin}`,
    `This address isn't monitored. Reply from your dashboard: ${dashboard}`,
    plain(reason)
  ]
    .filter((line, index, all) => !(line === '' && all[index - 1] === ''))
    .join('\n')

  const markup = html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${layout.subject}</title><style>@media (max-width: 600px) { .serp-content { padding: 32px 20px !important; } .serp-shell { padding: 24px 12px !important; } }</style></head>
<body style="${css({ 'background-color': T.page, margin: '0', padding: '0' })}"><div style="${css({ color: T.page, display: 'none', 'font-size': '1px', 'line-height': '1px', 'max-height': '0', 'mso-hide': 'all', opacity: '0', overflow: 'hidden' })}">${layout.preheader}</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${T.page}" style="${css({ 'background-color': T.page, 'border-collapse': 'collapse' })}"><tr><td class="serp-shell" align="center" style="${css({ padding: '40px 24px' })}"><!--[if mso]><table role="presentation" width="640" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]--><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${T.surface}" style="${css({ 'background-color': T.surface, border: `1px solid ${T.line}`, 'border-collapse': 'separate', 'max-width': '640px' })}"><tr><td class="serp-content" style="${css({ color: T.text, 'font-family': T.font, padding: '32px 40px' })}"><table role="presentation" cellpadding="0" cellspacing="0" border="0" style="${css({ 'border-collapse': 'collapse' })}"><tr><td style="${css({ 'padding-right': '8px', 'vertical-align': 'middle' })}"><img src="${context.links.url('/logo-512.png')}" width="20" height="20" alt="" style="${css({ border: '0', display: 'block', height: '20px', width: '20px' })}"></td><td style="${css({ color: T.ink, 'font-size': '18px', 'font-weight': '700', 'letter-spacing': '-0.01em', 'line-height': '24px', 'vertical-align': 'middle' })}">SERP</td></tr></table><h1 style="${css({ color: T.ink, 'font-size': '24px', 'font-weight': '700', 'letter-spacing': '-0.02em', 'line-height': '30px', margin: '32px 0 0 0' })}">${layout.heading}</h1>${layout.body.map(blockHtml)}${layout.code ? codeHtml(layout.code) : null}${layout.cta ? ctaHtml(layout.cta) : null}${after.map(blockHtml)}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="${css({ 'border-collapse': 'collapse', 'margin-top': '40px' })}"><tr><td style="${css({ 'border-top': `1px solid ${T.line}`, color: T.muted, 'font-size': '12px', 'line-height': '20px', 'padding-top': '24px' })}"><p style="${css({ margin: '0' })}"><b style="${css({ color: T.strong })}">SERP Directory</b> · ${host}</p><p style="${css({ margin: '0' })}">This address isn’t monitored. Reply from your dashboard: <a href="${dashboard}" style="${css({ color: T.strong, 'text-decoration': 'underline', 'word-break': 'break-all' })}">${dashboard}</a></p><p style="${css({ margin: '8px 0 0 0' })}">${reason}</p></td></tr></table></td></tr></table><!--[if mso]></td></tr></table><![endif]--></td></tr></table></body></html>`

  return { html: markup, subject: layout.subject, text }
}

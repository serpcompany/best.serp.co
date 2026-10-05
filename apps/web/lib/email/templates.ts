/**
 * The template contract. A template turns a typed input into a subject, a plain-text body,
 * and an HTML body; it never sends, reads the environment, or builds an origin itself. It
 * receives the environment's link helper, so every link is absolute and points at the
 * environment that sent the email (staging links stay on staging).
 *
 * HTML is built with the `html` tag, which escapes every interpolated value, so submitter
 * text (a product name, a rejection reason) can never inject markup. Values go in element
 * content or in quoted attributes only; a value in an `href` or `src` must be an `http:`,
 * `https:`, or `mailto:` URL. The real templates and their copy follow the mockups approved in
 * serpcompany/best.serp.co#70.
 */
import { isEmailTemplateId } from '@serpdirectory/data-ops/email-deliveries'
import { absoluteUrl } from '@serpdirectory/web-core/canonical-url'
import type { SiteEnvironment } from '../environment/site-environment'

export class EmailTemplateError extends Error {
  override name = 'EmailTemplateError'
}

// Not exported: only this module can mint SafeHtml, so markup can't bypass escaping.
const MINT: unique symbol = Symbol('SafeHtml')

/** Markup that is safe to place in an HTML body. Only the `html` tag creates it. */
export class SafeHtml {
  readonly #markup: string

  constructor(mint: typeof MINT, markup: string) {
    if (mint !== MINT) throw new EmailTemplateError('SafeHtml is created by the html tag only.')
    this.#markup = markup
  }

  /** True only for a real SafeHtml (a prototype copy without the private field fails). */
  static is(value: unknown): value is SafeHtml {
    return typeof value === 'object' && value !== null && #markup in value
  }

  toString(): string {
    return this.#markup
  }
}

export type HtmlValue = SafeHtml | string | number | false | null | undefined | readonly HtmlValue[]

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '"': '&quot;',
  '&': '&amp;',
  "'": '&#39;',
  '<': '&lt;',
  '>': '&gt;'
}

export function escapeHtml(value: string): string {
  return value.replace(/["&'<>]/gu, character => HTML_ESCAPES[character] ?? character)
}

function htmlValue(value: HtmlValue): string {
  if (SafeHtml.is(value)) return value.toString()
  if (Array.isArray(value)) return value.map(item => htmlValue(item)).join('')
  if (value === null || value === undefined || value === false) return ''
  return escapeHtml(String(value))
}

const LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])
const URL_ATTRIBUTES = new Set(['href', 'src'])

function isLinkUrl(value: string): boolean {
  if (/[\s\p{Cc}]/u.test(value)) return false
  try {
    return LINK_PROTOCOLS.has(new URL(value).protocol)
  } catch {
    return false
  }
}

type ValueContext =
  | { kind: 'content' }
  | { kind: 'tag' }
  | { kind: 'attribute'; prefix: string; url: boolean }

/** Where the next interpolated value lands, judged from the markup written so far. */
function valueContext(markup: string): ValueContext {
  const open = markup.lastIndexOf('<')
  if (open < 0 || open < markup.lastIndexOf('>')) return { kind: 'content' }
  const tag = markup.slice(open)
  let quote: string | null = null
  let valueStart = 0
  for (let index = 0; index < tag.length; index++) {
    const character = tag[index]
    if (quote) {
      if (character === quote) quote = null
    } else if (character === '"' || character === "'") {
      quote = character
      valueStart = index + 1
    }
  }
  if (!quote) return { kind: 'tag' }
  const name = /([^\s=]+)\s*=\s*$/u.exec(tag.slice(0, valueStart - 1))?.[1]?.toLowerCase()
  return { kind: 'attribute', prefix: tag.slice(valueStart), url: URL_ATTRIBUTES.has(name ?? '') }
}

function attributeValue(value: HtmlValue): string {
  if (value === null || value === undefined || value === false) return ''
  if (typeof value === 'string' || typeof value === 'number') return escapeHtml(String(value))
  throw new EmailTemplateError('Attribute values in email HTML must be strings or numbers.')
}

function interpolate(markup: string, value: HtmlValue): string {
  const context = valueContext(markup)
  if (context.kind === 'content') return htmlValue(value)
  if (context.kind === 'tag') {
    throw new EmailTemplateError('Email HTML takes values in element content or quoted attributes.')
  }
  if (context.url && !context.prefix.includes(':')) {
    // The value decides the URL's scheme, so it must be a whole, allowed link.
    if (context.prefix !== '' || typeof value !== 'string' || !isLinkUrl(value)) {
      throw new EmailTemplateError('Links in email HTML must be absolute http(s) or mailto URLs.')
    }
  }
  return attributeValue(value)
}

/**
 * Tagged template for HTML bodies: the literal parts are trusted markup, every interpolated
 * value is escaped unless it is itself `SafeHtml` (a nested `html` result). Arrays are joined;
 * `null`, `undefined`, and `false` render nothing. Values go in element content or in quoted
 * attributes only. An `href` or `src` value must be a whole absolute `http:`, `https:`, or
 * `mailto:` URL (use `links.url()` for site links). Anything else throws `EmailTemplateError`.
 */
export function html(strings: TemplateStringsArray, ...values: HtmlValue[]): SafeHtml {
  let markup = strings[0] ?? ''
  values.forEach((value, index) => {
    markup += interpolate(markup, value) + (strings[index + 1] ?? '')
  })
  return new SafeHtml(MINT, markup)
}

export interface EmailLinks {
  /** The environment's origin, e.g. `https://best.serp.co`. */
  readonly origin: string
  /**
   * The absolute, canonical URL of a root-relative path on this environment's site:
   * `url('/products/autoenhance.ai')` is `https://best.serp.co/products/autoenhance.ai/` in
   * production. Queries and fragments are kept. Anything but a root-relative path without
   * whitespace or control characters throws.
   */
  url(path: string): string
}

const UNSAFE_PATH_CHARACTERS = /[\s\p{Cc}\\]/u

export function createEmailLinks(origin: string): EmailLinks {
  const base = new URL(origin)
  if (base.origin !== origin) throw new EmailTemplateError('Email link origin must be an origin.')
  return {
    origin,
    url(path) {
      if (!path.startsWith('/') || path.startsWith('//') || UNSAFE_PATH_CHARACTERS.test(path)) {
        throw new EmailTemplateError(
          'Email links take a root-relative path such as /account/, without spaces.'
        )
      }
      const url = absoluteUrl(origin, path)
      if (new URL(url).origin !== origin) {
        throw new EmailTemplateError('Email links must stay on the sending environment.')
      }
      return url
    }
  }
}

export interface EmailRenderContext {
  environment: SiteEnvironment
  links: EmailLinks
  /** The contact address for the footer (`support@serp.co`). */
  supportAddress: string
}

export interface EmailContent {
  html: SafeHtml
  subject: string
  text: string
}

export interface EmailTemplate<Input> {
  /** Stable id, recorded with each delivery: lower-case letters, digits, and dashes. */
  readonly id: string
  render(input: Input, context: EmailRenderContext): EmailContent
}

export type TemplateInput<T> = T extends EmailTemplate<infer Input> ? Input : never

/** A registry keyed by template id. Templates are typed by their input. */
export type EmailTemplateRegistry = Readonly<Record<string, EmailTemplate<never>>>

export function defineEmailTemplate<Input>(template: EmailTemplate<Input>): EmailTemplate<Input> {
  if (!isEmailTemplateId(template.id)) {
    throw new EmailTemplateError(`Invalid email template id: ${template.id}.`)
  }
  return template
}

/** Checks that every entry is keyed by its own id, then returns the registry unchanged. */
export function createEmailTemplateRegistry<const R extends EmailTemplateRegistry>(
  templates: R
): R {
  for (const [key, template] of Object.entries(templates)) {
    if (template.id !== key || !isEmailTemplateId(key)) {
      throw new EmailTemplateError(`Email template ${key} must be registered under its own id.`)
    }
  }
  return templates
}

export interface RenderedEmail {
  html: string
  subject: string
  text: string
}

const MAX_SUBJECT_LENGTH = 200

/**
 * Renders a template and checks the result: a non-empty single-line subject (line breaks
 * and runs of whitespace collapse to one space) of at most 200 characters, and non-empty
 * text and HTML bodies.
 */
export function renderEmail<Input>(
  template: EmailTemplate<Input>,
  input: Input,
  context: EmailRenderContext
): RenderedEmail {
  const content = template.render(input, context)
  const subject = content.subject.replace(/\s+/gu, ' ').trim()
  if (!subject || subject.length > MAX_SUBJECT_LENGTH) {
    throw new EmailTemplateError(`Template ${template.id} rendered an empty or overlong subject.`)
  }
  if (!SafeHtml.is(content.html)) {
    throw new EmailTemplateError(`Template ${template.id} must build its HTML with the html tag.`)
  }
  const text = content.text.trim()
  const markup = content.html.toString().trim()
  if (!text || !markup) {
    throw new EmailTemplateError(`Template ${template.id} rendered an empty body.`)
  }
  return { html: markup, subject, text }
}

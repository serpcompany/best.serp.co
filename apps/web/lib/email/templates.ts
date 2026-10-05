/**
 * The template contract. A template turns a typed input into a subject, a plain-text body,
 * and an HTML body; it never sends, reads the environment, or builds an origin itself. It
 * receives the environment's link helper, so every link is absolute and points at the
 * environment that sent the email (staging links stay on staging).
 *
 * HTML is built with the `html` tag, which escapes every interpolated value, so submitter
 * text (a product name, a rejection reason) can never inject markup. The real templates and
 * their copy follow the mockups approved in serpcompany/best.serp.co#70.
 */
import { absoluteUrl } from '@serpdirectory/web-core/canonical-url'
import type { SiteEnvironment } from '../environment/site-environment'

export class EmailTemplateError extends Error {
  override name = 'EmailTemplateError'
}

/** Markup that is safe to place in an HTML body: built only by the `html` tag. */
export class SafeHtml {
  readonly #markup: string

  private constructor(markup: string) {
    this.#markup = markup
  }

  /** @internal Used by the `html` tag only. */
  static fromTrustedMarkup(markup: string): SafeHtml {
    return new SafeHtml(markup)
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
  if (value instanceof SafeHtml) return value.toString()
  if (Array.isArray(value)) return value.map(item => htmlValue(item)).join('')
  if (value === null || value === undefined || value === false) return ''
  return escapeHtml(String(value))
}

/**
 * Tagged template for HTML bodies: the literal parts are trusted markup, every interpolated
 * value is escaped unless it is itself `SafeHtml` (a nested `html` result). Arrays are joined;
 * `null`, `undefined`, and `false` render nothing.
 */
export function html(strings: TemplateStringsArray, ...values: HtmlValue[]): SafeHtml {
  let markup = strings[0] ?? ''
  values.forEach((value, index) => {
    markup += htmlValue(value) + (strings[index + 1] ?? '')
  })
  return SafeHtml.fromTrustedMarkup(markup)
}

export interface EmailLinks {
  /** The environment's origin, e.g. `https://best.serp.co`. */
  readonly origin: string
  /**
   * The absolute, canonical URL of a root-relative path on this environment's site:
   * `url('/products/autoenhance.ai')` is `https://best.serp.co/products/autoenhance.ai/` in
   * production. Queries and fragments are kept. Anything but a root-relative path throws.
   */
  url(path: string): string
}

export function createEmailLinks(origin: string): EmailLinks {
  const base = new URL(origin)
  if (base.origin !== origin) throw new EmailTemplateError('Email link origin must be an origin.')
  return {
    origin,
    url(path) {
      if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
        throw new EmailTemplateError('Email links take a root-relative path such as /account/.')
      }
      return absoluteUrl(origin, path)
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

const TEMPLATE_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u

export function defineEmailTemplate<Input>(template: EmailTemplate<Input>): EmailTemplate<Input> {
  if (!TEMPLATE_ID_PATTERN.test(template.id)) {
    throw new EmailTemplateError(`Invalid email template id: ${template.id}.`)
  }
  return template
}

/** Checks that every entry is keyed by its own id, then returns the registry unchanged. */
export function createEmailTemplateRegistry<const R extends EmailTemplateRegistry>(
  templates: R
): R {
  for (const [key, template] of Object.entries(templates)) {
    if (template.id !== key || !TEMPLATE_ID_PATTERN.test(key)) {
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
  if (!(content.html instanceof SafeHtml)) {
    throw new EmailTemplateError(`Template ${template.id} must build its HTML with the html tag.`)
  }
  const text = content.text.trim()
  const markup = content.html.toString().trim()
  if (!text || !markup) {
    throw new EmailTemplateError(`Template ${template.id} rendered an empty body.`)
  }
  return { html: markup, subject, text }
}

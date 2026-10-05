/**
 * The template contract. A template turns a typed input into a subject, a plain-text body,
 * and an HTML body; it never sends, reads the environment, or builds an origin itself. It
 * receives the environment's link helper, so every link is absolute and points at the
 * environment that sent the email (staging links stay on staging).
 *
 * HTML is built with the `html` tag, which escapes every interpolated value, so submitter
 * text (a product name, a rejection reason) can never inject markup. Values go in element
 * content or in quoted attributes only, and a value that forms a URL must be an absolute
 * `http(s)` URL or a `mailto:` with one plain address (see `html`). The real templates and
 * their copy follow the mockups approved in serpcompany/best.serp.co#70.
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

const LINK_PROTOCOLS = new Set(['http:', 'https:'])
/** Attributes whose value is a URL, so a value there could pick the scheme. */
const URL_ATTRIBUTES = new Set([
  'action',
  'background',
  'cite',
  'codebase',
  'data',
  'dynsrc',
  'formaction',
  'href',
  'icon',
  'longdesc',
  'lowsrc',
  'manifest',
  'poster',
  'profile',
  'src',
  'srcset',
  'usemap',
  'xlink:href'
])
/** Elements whose content is not HTML text (CSS, script), where escaping does not protect. */
const RAW_TEXT_ELEMENTS = new Set(['iframe', 'noembed', 'noscript', 'script', 'style', 'xmp'])
// One plain recipient and nothing else: no `?` query (cc, bcc, body, or headers) or escapes.
const MAILTO =
  /^mailto:[a-z0-9._+-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/iu
// What `encodeURIComponent` can output: a value after a fixed scheme stays one URL component.
const URL_COMPONENT = /^[A-Za-z0-9\-_.!~*'()%]*$/u

/** A whole link: an absolute `http(s)` URL, or `mailto:` one plain address. */
function isLinkUrl(value: string): boolean {
  if (/[\s\p{Cc}]/u.test(value)) return false
  if (/^mailto:/iu.test(value)) return MAILTO.test(value)
  try {
    return LINK_PROTOCOLS.has(new URL(value).protocol)
  } catch {
    return false
  }
}

type ValueContext =
  | { kind: 'content' }
  | { kind: 'rejected'; reason: string }
  | { kind: 'attribute'; name: string; prefix: string }

type ScanState =
  | 'text'
  | 'comment'
  | 'tag-name'
  | 'before-attribute'
  | 'attribute-name'
  | 'after-attribute-name'
  | 'before-value'
  | 'quoted-value'
  | 'unquoted-value'

interface Scan {
  attributeName: string
  closing: boolean
  quote: string
  /** The raw-text element (`style`, `script`, ...) whose content the scan is in. */
  rawText: string | null
  state: ScanState
  tagName: string
  valueStart: number
}

/** The scan after a tag's `>`: back to text, inside a raw-text element if one just opened. */
function afterTag(scan: Scan): void {
  const name = scan.tagName.toLowerCase()
  scan.rawText = !scan.closing && RAW_TEXT_ELEMENTS.has(name) ? name : null
  scan.state = 'text'
}

/** Advances the scan over one character; returns how many extra characters it consumed. */
function step(scan: Scan, markup: string, index: number): number {
  const character = markup[index] ?? ''
  switch (scan.state) {
    case 'text': {
      const rawText = scan.rawText
      if (rawText !== null) {
        if (markup.slice(index, index + rawText.length + 2).toLowerCase() === `</${rawText}`) {
          Object.assign(scan, { closing: true, rawText: null, state: 'tag-name', tagName: '' })
          return 1
        }
      } else if (markup.startsWith('<!--', index)) {
        scan.state = 'comment'
        return 3
      } else if (character === '<' && /[A-Za-z/!?]/u.test(markup[index + 1] ?? '')) {
        Object.assign(scan, { closing: false, state: 'tag-name', tagName: '' })
      }
      return 0
    }
    case 'comment':
      if (!markup.startsWith('-->', index)) return 0
      scan.state = 'text'
      return 2
    case 'tag-name':
      if (character === '>') afterTag(scan)
      else if (/\s/u.test(character)) scan.state = 'before-attribute'
      else if (character === '/' && scan.tagName === '') scan.closing = true
      else scan.tagName += character
      return 0
    case 'before-attribute':
    case 'after-attribute-name':
      if (character === '>') afterTag(scan)
      else if (character === '=' && scan.state === 'after-attribute-name') {
        scan.state = 'before-value'
      } else if (!/[\s/]/u.test(character)) {
        Object.assign(scan, { attributeName: character, state: 'attribute-name' })
      }
      return 0
    case 'attribute-name':
      if (character === '>') afterTag(scan)
      else if (character === '=') scan.state = 'before-value'
      else if (/\s/u.test(character)) scan.state = 'after-attribute-name'
      else scan.attributeName += character
      return 0
    case 'before-value':
      if (character === '>') afterTag(scan)
      else if (character === '"' || character === "'") {
        Object.assign(scan, { quote: character, state: 'quoted-value', valueStart: index + 1 })
      } else if (!/\s/u.test(character)) scan.state = 'unquoted-value'
      return 0
    case 'quoted-value':
      if (character === scan.quote) scan.state = 'before-attribute'
      return 0
    case 'unquoted-value':
      if (character === '>') afterTag(scan)
      else if (/\s/u.test(character)) scan.state = 'before-attribute'
      return 0
  }
}

/**
 * Where the next interpolated value lands. Scans the whole markup written so far, tracking
 * tags, attribute names, and quotes in one pass, so a `>` or a quote inside an earlier quoted
 * attribute cannot hide the real context.
 */
function valueContext(markup: string): ValueContext {
  const scan: Scan = {
    attributeName: '',
    closing: false,
    quote: '',
    rawText: null,
    state: 'text',
    tagName: '',
    valueStart: 0
  }
  for (let index = 0; index < markup.length; index++) index += step(scan, markup, index)

  if (scan.state === 'text') {
    return scan.rawText === null
      ? { kind: 'content' }
      : { kind: 'rejected', reason: `Email HTML takes no values inside <${scan.rawText}>.` }
  }
  if (scan.state === 'quoted-value') {
    return {
      kind: 'attribute',
      name: scan.attributeName.toLowerCase(),
      prefix: markup.slice(scan.valueStart)
    }
  }
  if (scan.state === 'comment') {
    return { kind: 'rejected', reason: 'Email HTML takes no values in comments.' }
  }
  return {
    kind: 'rejected',
    reason: 'Email HTML takes values in element content or quoted attributes only.'
  }
}

function attributeValue(value: HtmlValue): string {
  if (value === null || value === undefined || value === false) return ''
  if (typeof value === 'string' || typeof value === 'number') return escapeHtml(String(value))
  throw new EmailTemplateError('Attribute values in email HTML must be strings or numbers.')
}

function interpolate(markup: string, value: HtmlValue): string {
  const context = valueContext(markup)
  if (context.kind === 'content') return htmlValue(value)
  if (context.kind === 'rejected') throw new EmailTemplateError(context.reason)
  if (context.name === 'style' || context.name.startsWith('on')) {
    throw new EmailTemplateError(`Email HTML takes no values in a ${context.name} attribute.`)
  }
  if (URL_ATTRIBUTES.has(context.name)) {
    const prefix = context.prefix.trimStart()
    if (prefix === '') {
      // The value is the whole URL, so it must be a whole, allowed link.
      if (context.prefix !== '' || typeof value !== 'string' || !isLinkUrl(value)) {
        throw new EmailTemplateError('Links in email HTML must be absolute http(s) or mailto URLs.')
      }
    } else if (!/^[a-z][a-z0-9+.-]*:/iu.test(prefix)) {
      throw new EmailTemplateError('A link value must be the whole URL or follow its scheme.')
    } else if (
      !(typeof value === 'string' || typeof value === 'number') ||
      !URL_COMPONENT.test(String(value))
    ) {
      throw new EmailTemplateError('A value inside a link must be encodeURIComponent-encoded.')
    }
  }
  return attributeValue(value)
}

/** A real tagged-template call: frozen strings with frozen `raw`, never a hand-built array. */
function isTemplateStrings(strings: unknown): strings is TemplateStringsArray {
  return (
    Array.isArray(strings) &&
    Object.isFrozen(strings) &&
    'raw' in strings &&
    Array.isArray(strings.raw) &&
    Object.isFrozen(strings.raw) &&
    strings.raw.length === strings.length
  )
}

/**
 * Tagged template for HTML bodies: the literal parts are trusted markup, every interpolated
 * value is escaped unless it is itself `SafeHtml` (a nested `html` result). Arrays are joined;
 * `null`, `undefined`, and `false` render nothing.
 *
 * Values go in element content or in quoted attributes only: never in a tag, an unquoted
 * attribute, a comment, `<style>` or `<script>`, a `style` attribute, or an `on*` handler. In a
 * URL attribute (`href`, `src`, `background`, `action`, `poster`, ...) a value is either the
 * whole URL (an absolute `http(s)` URL, or `mailto:` one plain address; use `links.url()` for
 * site links) or an `encodeURIComponent`-encoded part after a scheme the literal fixes.
 * Anything else throws `EmailTemplateError`.
 */
export function html(strings: TemplateStringsArray, ...values: HtmlValue[]): SafeHtml {
  if (!isTemplateStrings(strings)) {
    throw new EmailTemplateError('html is a tagged template: call it as html`...`.')
  }
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

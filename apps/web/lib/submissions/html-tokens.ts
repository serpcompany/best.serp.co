import { decodeEntities } from './prefill'

/**
 * The start and end tags a browser would see in an HTML document, for the badge check
 * (PR #84 review round 1, finding 1). It follows the HTML tokenizer where that decides what
 * renders, and fails closed where it simplifies:
 *
 * - Comments (`<!-- … -->`, including the `<!-->` and `--!>` forms), doctypes, CDATA and other
 *   bogus comments produce no tags.
 * - The contents of raw-text and escapable-raw-text elements (`script`, `style`, `xmp`,
 *   `iframe`, `noembed`, `noframes`, `noscript`, `textarea`, `title`) are text, up to the
 *   matching end tag; `plaintext` ends the document.
 * - Nothing inside `<template>` is rendered, so tags there (nested templates included) are
 *   skipped.
 * - Attributes are read in order with their quoted values consumed, so a name inside another
 *   attribute's value is never an attribute; the first occurrence of a name wins; values are
 *   entity-decoded; names are lowercase.
 * - A tag cut off by the end of the document is dropped.
 *
 * `inForeignContent` is true inside `<svg>` or `<math>`, whose `<a>` is not an HTML link.
 */

export interface HtmlStartTag {
  attributes: ReadonlyMap<string, string>
  inForeignContent: boolean
  kind: 'start'
  name: string
}

export interface HtmlEndTag {
  inForeignContent: boolean
  kind: 'end'
  name: string
}

export type HtmlTag = HtmlEndTag | HtmlStartTag

const RAW_TEXT_ELEMENTS = new Set([
  'iframe',
  'noembed',
  'noframes',
  'noscript',
  'script',
  'style',
  'textarea',
  'title',
  'xmp'
])

/** Start tags that break out of `<svg>` / `<math>` content (HTML, "in foreign content"). */
const FOREIGN_BREAKOUT = new Set([
  'b',
  'big',
  'blockquote',
  'body',
  'br',
  'center',
  'code',
  'dd',
  'div',
  'dl',
  'dt',
  'em',
  'embed',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'head',
  'hr',
  'i',
  'img',
  'li',
  'listing',
  'menu',
  'meta',
  'nobr',
  'ol',
  'p',
  'pre',
  'ruby',
  's',
  'small',
  'span',
  'strike',
  'strong',
  'sub',
  'sup',
  'table',
  'tt',
  'u',
  'ul',
  'var'
])

const WHITESPACE = /[\t\n\f\r ]/u
const LETTER = /[A-Za-z]/u

function isWhitespace(char: string | undefined): boolean {
  return char !== undefined && WHITESPACE.test(char)
}

interface ParsedTag {
  attributes: Map<string, string>
  end: number
  name: string
}

/**
 * Reads a tag from just after `<` (or `</`) at `start`: its name, then its attributes.
 * Returns null when the document ends inside the tag.
 */
function readTag(html: string, start: number): ParsedTag | null {
  let position = start
  let name = ''
  while (position < html.length) {
    const char = html[position] as string
    if (isWhitespace(char) || char === '/' || char === '>') break
    name += char
    position += 1
  }
  const attributes = new Map<string, string>()
  while (position < html.length) {
    const char = html[position] as string
    if (isWhitespace(char) || char === '/') {
      position += 1
      continue
    }
    if (char === '>') return { attributes, end: position + 1, name: name.toLowerCase() }
    // Attribute name: a leading `=` belongs to the name, as in the tokenizer.
    let attributeName = char
    position += 1
    while (position < html.length) {
      const next = html[position] as string
      if (isWhitespace(next) || next === '/' || next === '>' || next === '=') break
      attributeName += next
      position += 1
    }
    while (isWhitespace(html[position])) position += 1
    let value = ''
    if (html[position] === '=') {
      position += 1
      while (isWhitespace(html[position])) position += 1
      const quote = html[position]
      if (quote === '"' || quote === "'") {
        const close = html.indexOf(quote, position + 1)
        if (close === -1) return null
        value = html.slice(position + 1, close)
        position = close + 1
      } else {
        while (position < html.length) {
          const next = html[position] as string
          if (isWhitespace(next) || next === '>') break
          value += next
          position += 1
        }
      }
    }
    const key = attributeName.toLowerCase()
    if (!attributes.has(key)) attributes.set(key, decodeEntities(value))
  }
  return null
}

/** The end of a comment that starts after `<!--` at `start`, or -1 at the end of the document. */
function commentEnd(html: string, start: number): number {
  if (html.startsWith('>', start)) return start + 1
  if (html.startsWith('->', start)) return start + 2
  const dashes = html.indexOf('-->', start)
  const bang = html.indexOf('--!>', start)
  if (dashes === -1 && bang === -1) return -1
  if (bang !== -1 && (dashes === -1 || bang < dashes)) return bang + 4
  return dashes + 3
}

/** The position after the end tag that closes raw-text element `name`, or -1. */
function rawTextEnd(html: string, start: number, name: string): number {
  const pattern = new RegExp(`</${name}(?=[\\t\\n\\f\\r />])`, 'giu')
  pattern.lastIndex = start
  const match = pattern.exec(html)
  if (!match) return -1
  const tag = readTag(html, match.index + 2)
  return tag ? tag.end : -1
}

export function* htmlTags(html: string): Generator<HtmlTag> {
  let position = 0
  let templateDepth = 0
  let foreignDepth = 0
  while (position < html.length) {
    const open = html.indexOf('<', position)
    if (open === -1) return
    position = open + 1
    if (html.startsWith('!--', position)) {
      const end = commentEnd(html, position + 3)
      if (end === -1) return
      position = end
      continue
    }
    const next = html[position]
    if (next === '!' || next === '?') {
      const end = html.indexOf('>', position)
      if (end === -1) return
      position = end + 1
      continue
    }
    if (next === '/') {
      const first = html[position + 1]
      if (first === '>') {
        position += 2
        continue
      }
      if (first === undefined || !LETTER.test(first)) {
        const end = html.indexOf('>', position)
        if (end === -1) return
        position = end + 1
        continue
      }
      const tag = readTag(html, position + 1)
      if (!tag) return
      position = tag.end
      if (tag.name === 'template') {
        if (templateDepth > 0) templateDepth -= 1
        continue
      }
      if (templateDepth > 0) continue
      if ((tag.name === 'svg' || tag.name === 'math') && foreignDepth > 0) foreignDepth -= 1
      yield { inForeignContent: foreignDepth > 0, kind: 'end', name: tag.name }
      continue
    }
    if (next === undefined || !LETTER.test(next)) continue
    const tag = readTag(html, position)
    if (!tag) return
    position = tag.end
    if (tag.name === 'plaintext') return
    if (RAW_TEXT_ELEMENTS.has(tag.name)) {
      const end = rawTextEnd(html, position, tag.name)
      if (end === -1) return
      position = end
      if (templateDepth === 0) {
        yield {
          attributes: tag.attributes,
          inForeignContent: foreignDepth > 0,
          kind: 'start',
          name: tag.name
        }
      }
      continue
    }
    if (tag.name === 'template') {
      templateDepth += 1
      continue
    }
    if (templateDepth > 0) continue
    // These HTML start tags end foreign content (the tree builder pops back to HTML).
    if (foreignDepth > 0 && FOREIGN_BREAKOUT.has(tag.name)) foreignDepth = 0
    const selfClosing = html[tag.end - 2] === '/'
    if ((tag.name === 'svg' || tag.name === 'math') && !selfClosing) foreignDepth += 1
    yield {
      attributes: tag.attributes,
      inForeignContent: foreignDepth > 0 && tag.name !== 'svg' && tag.name !== 'math',
      kind: 'start',
      name: tag.name
    }
  }
}

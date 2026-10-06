/**
 * MIME types as Fetch and WHATWG MIME Sniffing read them (moved from submit v2's
 * `apps/web/lib/submissions/html-encoding.ts`, PR #84 review rounds 4 and 5): `safeFetch` checks
 * a response's type with `fetchMimeType`, so repeated `Content-Type` headers (joined with
 * commas) and quoted parameters are read the way a browser reads them. The badge verifier's
 * encoding sniffing builds on the same parser.
 */

const TOKEN = /^[!#$%&'*+.^_`|~0-9a-z-]+$/iu
const HTTP_SPACE = /[\t\n\r ]/u

/**
 * Fetch's "collect an HTTP quoted string" from `text` at `start` (a `"`): the position after
 * it, and its value unescaped when `extract` is set, or else as written.
 */
function quotedString(text: string, start: number, extract: boolean): [number, string] {
  let position = start + 1
  let value = ''
  while (position < text.length) {
    const char = text[position] as string
    position += 1
    if (char === '"') break
    if (char === '\\') {
      if (position >= text.length) {
        value += '\\'
        break
      }
      value += text[position]
      position += 1
      continue
    }
    value += char
  }
  return [position, extract ? value : text.slice(start, position)]
}

/** Fetch's "split" of a header value on commas outside quoted strings. */
export function splitHeaderValue(value: string): string[] {
  const values: string[] = []
  let position = 0
  let current = ''
  for (;;) {
    while (position < value.length && value[position] !== '"' && value[position] !== ',') {
      current += value[position]
      position += 1
    }
    if (position < value.length && value[position] === '"') {
      const [next, quoted] = quotedString(value, position, false)
      current += quoted
      position = next
      if (position < value.length) continue
    }
    values.push(current.replace(/^[\t ]+|[\t ]+$/gu, ''))
    current = ''
    if (position >= value.length) return values
    position += 1
  }
}

export interface MimeType {
  essence: string
  parameters: Map<string, string>
}

/** WHATWG "parse a MIME type", or null for a value that isn't one. */
export function parseMimeType(input: string): MimeType | null {
  const text = input.replace(/^[\t\n\r ]+|[\t\n\r ]+$/gu, '')
  const slash = text.indexOf('/')
  const type = text.slice(0, Math.max(slash, 0))
  if (slash === -1 || !TOKEN.test(type)) return null
  let position = text.indexOf(';', slash)
  if (position === -1) position = text.length
  const subtype = text.slice(slash + 1, position).replace(/[\t\n\r ]+$/u, '')
  if (!TOKEN.test(subtype)) return null
  const parameters = new Map<string, string>()
  while (position < text.length) {
    position += 1
    while (HTTP_SPACE.test(text[position] ?? '')) position += 1
    let nameEnd = position
    while (nameEnd < text.length && text[nameEnd] !== ';' && text[nameEnd] !== '=') nameEnd += 1
    const name = text.slice(position, nameEnd).toLowerCase()
    position = nameEnd
    if (position >= text.length) break
    if (text[position] === ';') continue
    position += 1
    if (position >= text.length) break
    let value: string
    if (text[position] === '"') {
      ;[position, value] = quotedString(text, position, true)
      while (position < text.length && text[position] !== ';') position += 1
    } else {
      const valueEnd =
        text.indexOf(';', position) === -1 ? text.length : text.indexOf(';', position)
      value = text.slice(position, valueEnd).replace(/[\t\n\r ]+$/u, '')
      position = valueEnd
      if (value === '') continue
    }
    if (
      TOKEN.test(name) &&
      /^[\t\u0020-\u007e\u0080-\u00ff]*$/u.test(value) &&
      !parameters.has(name)
    ) {
      parameters.set(name, value)
    }
  }
  return { essence: `${type}/${subtype}`.toLowerCase(), parameters }
}

export interface ExtractedMimeType {
  charset: string | null
  essence: string
}

/**
 * Every MIME type in a `Content-Type` value (repeated headers joined with commas), with the
 * distinct essences and charsets seen (each charset as `charsetKey` names it) and Fetch's
 * result: the last valid MIME type, with the charset carried over from earlier values of the
 * same type.
 */
export function extractMimeTypes(
  value: string | null | undefined,
  charsetKey: (label: string) => string = label => label.toLowerCase()
): {
  charsets: Set<string>
  essences: Set<string>
  result: ExtractedMimeType | null
} {
  const charsets = new Set<string>()
  const essences = new Set<string>()
  let charset: string | null = null
  let essence: string | null = null
  let result: ExtractedMimeType | null = null
  for (const part of value === null || value === undefined ? [] : splitHeaderValue(value)) {
    const mime = parseMimeType(part)
    if (!mime || mime.essence === '*/*') continue
    const own = mime.parameters.get('charset') ?? null
    essences.add(mime.essence)
    if (own !== null) charsets.add(charsetKey(own))
    if (mime.essence !== essence) {
      charset = own
      essence = mime.essence
    }
    result = { charset: own ?? charset, essence: mime.essence }
  }
  return { charsets, essences, result }
}

/**
 * Fetch's "extract a MIME type" from a `Content-Type` value, as a fetch hands it over (repeated
 * headers joined with commas): the last valid MIME type, with the charset carried over from
 * earlier values of the same type. Null when there is none. `safeFetch` checks the type with it,
 * so two identical `text/html` headers are HTML (PR #84 review round 5).
 */
export function fetchMimeType(value: string | null | undefined): ExtractedMimeType | null {
  return extractMimeTypes(value).result
}

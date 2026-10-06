/**
 * Decoding a fetched HTML page the way a browser does (PR #84 review round 3, finding 1), so
 * the badge check reads the same characters Chromium shows. The WHATWG encoding sniffing
 * algorithm, without the parts that need a renderer:
 * 1. a byte order mark (UTF-8, UTF-16BE, UTF-16LE);
 * 2. the `charset` of the `Content-Type` header;
 * 3. a `<meta charset>` or `<meta http-equiv="content-type">` in the first 1024 bytes (the
 *    prescan), where UTF-16 means UTF-8 and `x-user-defined` means windows-1252;
 * 4. otherwise UTF-8.
 * Unknown labels are skipped, as browsers skip them. The page is then decoded with that
 * encoding's `TextDecoder` (workerd and Node support every WHATWG encoding). A page whose
 * encoding is `replacement` (ISO-2022-KR, ISO-2022-CN, HZ-GB-2312), which a browser shows as
 * a single U+FFFD, or one this runtime can't decode, returns null: the caller fails closed.
 */

/** WHATWG Encoding: each encoding's name and its labels (encoding.spec.whatwg.org). */
const ENCODINGS: ReadonlyArray<readonly [string, string]> = [
  ['utf-8', 'unicode-1-1-utf-8 unicode11utf8 unicode20utf8 utf-8 utf8 x-unicode20utf8'],
  ['ibm866', '866 cp866 csibm866 ibm866'],
  [
    'iso-8859-2',
    'csisolatin2 iso-8859-2 iso-ir-101 iso8859-2 iso88592 iso_8859-2 iso_8859-2:1987 l2 latin2'
  ],
  [
    'iso-8859-3',
    'csisolatin3 iso-8859-3 iso-ir-109 iso8859-3 iso88593 iso_8859-3 iso_8859-3:1988 l3 latin3'
  ],
  [
    'iso-8859-4',
    'csisolatin4 iso-8859-4 iso-ir-110 iso8859-4 iso88594 iso_8859-4 iso_8859-4:1988 l4 latin4'
  ],
  [
    'iso-8859-5',
    'csisolatincyrillic cyrillic iso-8859-5 iso-ir-144 iso8859-5 iso88595 iso_8859-5 iso_8859-5:1988'
  ],
  [
    'iso-8859-6',
    'arabic asmo-708 csiso88596e csiso88596i csisolatinarabic ecma-114 iso-8859-6 iso-8859-6-e iso-8859-6-i iso-ir-127 iso8859-6 iso88596 iso_8859-6 iso_8859-6:1987'
  ],
  [
    'iso-8859-7',
    'csisolatingreek ecma-118 elot_928 greek greek8 iso-8859-7 iso-ir-126 iso8859-7 iso88597 iso_8859-7 iso_8859-7:1987 sun_eu_greek'
  ],
  [
    'iso-8859-8',
    'csiso88598e csisolatinhebrew hebrew iso-8859-8 iso-8859-8-e iso-ir-138 iso8859-8 iso88598 iso_8859-8 iso_8859-8:1988 visual'
  ],
  ['iso-8859-8-i', 'csiso88598i iso-8859-8-i logical'],
  ['iso-8859-10', 'csisolatin6 iso-8859-10 iso-ir-157 iso8859-10 iso885910 l6 latin6'],
  ['iso-8859-13', 'iso-8859-13 iso8859-13 iso885913'],
  ['iso-8859-14', 'iso-8859-14 iso8859-14 iso885914'],
  ['iso-8859-15', 'csisolatin9 iso-8859-15 iso8859-15 iso885915 iso_8859-15 l9'],
  ['iso-8859-16', 'iso-8859-16'],
  ['koi8-r', 'cskoi8r koi koi8 koi8-r koi8_r'],
  ['koi8-u', 'koi8-ru koi8-u'],
  ['macintosh', 'csmacintosh mac macintosh x-mac-roman'],
  ['windows-874', 'dos-874 iso-8859-11 iso8859-11 iso885911 tis-620 windows-874'],
  ['windows-1250', 'cp1250 windows-1250 x-cp1250'],
  ['windows-1251', 'cp1251 windows-1251 x-cp1251'],
  [
    'windows-1252',
    'ansi_x3.4-1968 ascii cp1252 cp819 csisolatin1 ibm819 iso-8859-1 iso-ir-100 iso8859-1 iso88591 iso_8859-1 iso_8859-1:1987 l1 latin1 us-ascii windows-1252 x-cp1252'
  ],
  ['windows-1253', 'cp1253 windows-1253 x-cp1253'],
  [
    'windows-1254',
    'cp1254 csisolatin5 iso-8859-9 iso-ir-148 iso8859-9 iso88599 iso_8859-9 iso_8859-9:1989 l5 latin5 windows-1254 x-cp1254'
  ],
  ['windows-1255', 'cp1255 windows-1255 x-cp1255'],
  ['windows-1256', 'cp1256 windows-1256 x-cp1256'],
  ['windows-1257', 'cp1257 windows-1257 x-cp1257'],
  ['windows-1258', 'cp1258 windows-1258 x-cp1258'],
  ['x-mac-cyrillic', 'x-mac-cyrillic x-mac-ukrainian'],
  ['gbk', 'chinese csgb2312 csiso58gb231280 gb2312 gb_2312 gb_2312-80 gbk iso-ir-58 x-gbk'],
  ['gb18030', 'gb18030'],
  ['big5', 'big5 big5-hkscs cn-big5 csbig5 x-x-big5'],
  ['euc-jp', 'cseucpkdfmtjapanese euc-jp x-euc-jp'],
  ['iso-2022-jp', 'csiso2022jp iso-2022-jp'],
  ['shift_jis', 'csshiftjis ms932 ms_kanji shift-jis shift_jis sjis windows-31j x-sjis'],
  [
    'euc-kr',
    'cseuckr csksc56011987 euc-kr iso-ir-149 korean ks_c_5601-1987 ks_c_5601-1989 ksc5601 ksc_5601 windows-949'
  ],
  ['replacement', 'csiso2022kr hz-gb-2312 iso-2022-cn iso-2022-cn-ext iso-2022-kr replacement'],
  ['utf-16be', 'unicodefffe utf-16be'],
  ['utf-16le', 'csunicode iso-10646-ucs-2 ucs-2 unicode unicodefeff utf-16 utf-16le'],
  ['x-user-defined', 'x-user-defined']
]

const ENCODING_BY_LABEL = new Map(
  ENCODINGS.flatMap(([name, labels]) => labels.split(' ').map(label => [label, name] as const))
)

const PRESCAN_BYTES = 1024
const SPACE = new Set([0x09, 0x0a, 0x0c, 0x0d, 0x20])

/** The encoding for a label, or null when the label is unknown ("get an encoding"). */
export function encodingForLabel(label: string): string | null {
  return ENCODING_BY_LABEL.get(label.trim().toLowerCase()) ?? null
}

function bomEncoding(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8'
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be'
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le'
  return null
}

/** The encoding of a `Content-Type` header's first `charset` parameter, when it names one. */
export function contentTypeEncoding(contentType: string | null | undefined): string | null {
  const parameters = (contentType ?? '').split(';').slice(1).join(';')
  const pattern =
    /(?:^|;)[\t\n\r ]*([^=;\t\n\r ]+)[\t\n\r ]*=[\t\n\r ]*("(?:[^"\\]|\\.)*"?|[^;]*)/gu
  for (const match of parameters.matchAll(pattern)) {
    if (match[1]?.toLowerCase() !== 'charset') continue
    const raw = match[2] ?? ''
    const value = raw.startsWith('"')
      ? raw.replace(/^"|"$/gu, '').replace(/\\(.)/gu, '$1')
      : raw.trimEnd()
    return encodingForLabel(value)
  }
  return null
}

/** "The algorithm for extracting a character encoding from a meta element", on `content`. */
function metaContentEncoding(content: string): string | null {
  let position = 0
  for (;;) {
    const found = content.indexOf('charset', position)
    if (found === -1) return null
    position = found + 7
    while (/[\t\n\f\r ]/u.test(content[position] ?? '')) position += 1
    if (content[position] !== '=') continue
    position += 1
    while (/[\t\n\f\r ]/u.test(content[position] ?? '')) position += 1
    const next = content[position]
    if (next === undefined) return null
    if (next === '"' || next === "'") {
      const close = content.indexOf(next, position + 1)
      return close === -1 ? null : encodingForLabel(content.slice(position + 1, close))
    }
    const rest = content.slice(position)
    return encodingForLabel(rest.slice(0, rest.search(/[\t\n\f\r ;]|$/u)))
  }
}

class EndOfPrescan extends Error {}

/** The WHATWG prescan of the first 1024 bytes for a `<meta>` encoding declaration. */
export function prescanEncoding(input: Uint8Array): string | null {
  const bytes = input.subarray(0, PRESCAN_BYTES)
  let position = 0
  const at = (index: number): number => {
    const byte = bytes[index]
    if (byte === undefined) throw new EndOfPrescan()
    return byte
  }
  const lower = (byte: number): string =>
    String.fromCharCode(byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte)
  const startsWith = (text: string, caseInsensitive = false): boolean => {
    for (let index = 0; index < text.length; index += 1) {
      const byte = bytes[position + index]
      if (byte === undefined) return false
      const char = caseInsensitive ? lower(byte) : String.fromCharCode(byte)
      if (char !== text[index]) return false
    }
    return true
  }
  const isLetter = (byte: number | undefined): boolean =>
    byte !== undefined && ((byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a))

  /** "Get an attribute": null when there is none (a `>`). */
  const attribute = (): { name: string; value: string } | null => {
    while (SPACE.has(at(position)) || at(position) === 0x2f) position += 1
    if (at(position) === 0x3e) return null
    let name = ''
    let value = ''
    for (;;) {
      const byte = at(position)
      if (byte === 0x3d && name !== '') {
        position += 1
        break
      }
      if (SPACE.has(byte)) {
        while (SPACE.has(at(position))) position += 1
        if (at(position) !== 0x3d) return { name, value }
        position += 1
        break
      }
      if (byte === 0x2f || byte === 0x3e) return { name, value }
      name += lower(byte)
      position += 1
    }
    while (SPACE.has(at(position))) position += 1
    const first = at(position)
    if (first === 0x22 || first === 0x27) {
      for (;;) {
        position += 1
        const byte = at(position)
        if (byte === first) {
          position += 1
          return { name, value }
        }
        value += lower(byte)
      }
    }
    if (first === 0x3e) return { name, value }
    value += lower(first)
    for (;;) {
      position += 1
      const byte = at(position)
      if (SPACE.has(byte) || byte === 0x3e) return { name, value }
      value += lower(byte)
    }
  }

  try {
    while (position < bytes.length) {
      if (startsWith('<!--')) {
        // The first `>` after two `-`, which may be the two in `<!--`.
        let end = position + 4
        while (!(at(end) === 0x3e && at(end - 1) === 0x2d && at(end - 2) === 0x2d)) end += 1
        position = end
      } else if (
        startsWith('<meta', true) &&
        (SPACE.has(at(position + 5)) || at(position + 5) === 0x2f)
      ) {
        position += 5
        const seen = new Set<string>()
        let gotPragma = false
        let needPragma: boolean | null = null
        let charset: string | null | undefined
        for (let item = attribute(); item; item = attribute()) {
          if (seen.has(item.name)) continue
          seen.add(item.name)
          if (item.name === 'http-equiv') {
            if (item.value === 'content-type') gotPragma = true
          } else if (item.name === 'content') {
            const encoding = metaContentEncoding(item.value)
            if (encoding && charset === undefined) {
              charset = encoding
              needPragma = true
            }
          } else if (item.name === 'charset') {
            charset = encodingForLabel(item.value)
            needPragma = false
          }
        }
        if (needPragma !== null && (!needPragma || gotPragma) && charset) {
          if (charset === 'utf-16be' || charset === 'utf-16le') return 'utf-8'
          if (charset === 'x-user-defined') return 'windows-1252'
          return charset
        }
      } else if (
        at(position) === 0x3c &&
        (isLetter(bytes[position + 1]) ||
          (bytes[position + 1] === 0x2f && isLetter(bytes[position + 2])))
      ) {
        while (!SPACE.has(at(position)) && at(position) !== 0x3e) position += 1
        while (attribute()) {
          // Skip the tag's attributes.
        }
      } else if (startsWith('<!') || startsWith('</') || startsWith('<?')) {
        while (at(position) !== 0x3e) position += 1
      }
      position += 1
    }
  } catch (error) {
    if (!(error instanceof EndOfPrescan)) throw error
  }
  return null
}

export interface DecodedHtml {
  encoding: string
  html: string
}

/**
 * The page's text, decoded as a browser would, or null when a browser would not show its
 * markup (the `replacement` encoding) or this runtime can't decode its encoding.
 */
export function decodeHtml(bytes: Uint8Array, contentType: string | null): DecodedHtml | null {
  const encoding =
    bomEncoding(bytes) ?? contentTypeEncoding(contentType) ?? prescanEncoding(bytes) ?? 'utf-8'
  if (encoding === 'replacement') return null
  let decoder: TextDecoder
  try {
    decoder = new TextDecoder(encoding)
  } catch {
    return null
  }
  return { encoding, html: decoder.decode(bytes) }
}

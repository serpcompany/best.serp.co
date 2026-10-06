import { describe, expect, it } from 'vitest'
import {
  declaredEncodings,
  decodeHtml,
  encodingForLabel,
  extractMimeType,
  fetchMimeType,
  isAsciiCompatible,
  isPureAscii,
  parseMimeType,
  prescanEncoding,
  splitHeaderValue
} from './html-encoding'

const bytes = (text: string) => new TextEncoder().encode(text)

describe('encoding labels', () => {
  it('maps WHATWG labels to their encoding and ignores unknown ones', () => {
    expect(encodingForLabel(' UTF8 ')).toBe('utf-8')
    expect(encodingForLabel('latin1')).toBe('windows-1252')
    expect(encodingForLabel('ascii')).toBe('windows-1252')
    expect(encodingForLabel('sjis')).toBe('shift_jis')
    expect(encodingForLabel('iso-2022-kr')).toBe('replacement')
    expect(encodingForLabel('utf-16')).toBe('utf-16le')
    expect(encodingForLabel('utf-7')).toBeNull()
    expect(encodingForLabel('')).toBeNull()
  })
})

describe('Content-Type, as Fetch reads it', () => {
  it('parses a MIME type and its first charset parameter, quoted or not', () => {
    const charset = (value: string) => parseMimeType(value)?.parameters.get('charset')
    expect(parseMimeType(' Text/HTML ; Charset=UTF-16LE ')?.essence).toBe('text/html')
    expect(charset('text/html; charset=UTF-16LE')).toBe('UTF-16LE')
    expect(charset('text/html;charset="ISO-8859-1"')).toBe('ISO-8859-1')
    expect(charset('text/html; q="a;b"; charset=euc-kr; charset=utf-8')).toBe('euc-kr')
    expect(charset('text/html; charset="a\\"b"')).toBe('a"b')
    expect(parseMimeType('text')).toBeNull()
    expect(parseMimeType('text/')).toBeNull()
    expect(parseMimeType('te xt/html')).toBeNull()
  })

  it('splits joined header values on commas outside quoted strings', () => {
    expect(splitHeaderValue('text/html; charset=utf-16le, text/html')).toEqual([
      'text/html; charset=utf-16le',
      'text/html'
    ])
    expect(splitHeaderValue('inline; filename="a,b.html"')).toEqual(['inline; filename="a,b.html"'])
  })

  it('extracts the last MIME type, carrying a charset over within one type', () => {
    expect(extractMimeType('text/html; charset=UTF-16LE')).toEqual({
      charset: 'UTF-16LE',
      essence: 'text/html'
    })
    // Two headers, `text/html; charset=utf-16le` and `text/html`: Chromium decodes UTF-16LE.
    expect(extractMimeType('text/html; charset=utf-16le, text/html')).toEqual({
      charset: 'utf-16le',
      essence: 'text/html'
    })
    expect(extractMimeType('text/html, */*, bogus')).toEqual({
      charset: null,
      essence: 'text/html'
    })
    expect(extractMimeType('text/html; charset=bogus')).toEqual({
      charset: 'bogus',
      essence: 'text/html'
    })
    expect(extractMimeType(null)).toBeNull()
    expect(extractMimeType('bogus')).toBeNull()
  })

  it('reads the type as Fetch does for safeFetch, so identical headers are HTML (round 5)', () => {
    expect(fetchMimeType('text/html, text/html')).toEqual({ charset: null, essence: 'text/html' })
    expect(extractMimeType('text/html, text/html')).toEqual({ charset: null, essence: 'text/html' })
    // The last type wins for the fetch; the checker then refuses the disagreement.
    expect(fetchMimeType('text/plain, text/html')?.essence).toBe('text/html')
    expect(fetchMimeType('text/html, text/plain')?.essence).toBe('text/plain')
    expect(extractMimeType('text/plain, text/html')).toBeNull()
  })

  it('fails closed when joined values disagree on the type or the charset (round 4)', () => {
    expect(extractMimeType('text/html; charset=utf-8, text/plain')).toBeNull()
    expect(extractMimeType('text/plain, text/html')).toBeNull()
    expect(extractMimeType('text/html; charset=utf-8, text/html; charset=utf-16le')).toBeNull()
    // The same charset twice, by any label, agrees.
    expect(extractMimeType('text/html; charset=latin1, text/html; charset=ISO-8859-1')).toEqual({
      charset: 'ISO-8859-1',
      essence: 'text/html'
    })
  })
})

describe('meta prescan', () => {
  it.each([
    ['<meta charset="Shift_JIS">', 'shift_jis'],
    ["<META CHARSET='euc-jp'/>", 'euc-jp'],
    ['<meta charset=koi8-r>', 'koi8-r'],
    ['<meta http-equiv="Content-Type" content="text/html; charset=gbk">', 'gbk'],
    ['<meta content="text/html; charset=\'big5\'" http-equiv=content-type>', 'big5'],
    // A declared UTF-16 means UTF-8, and x-user-defined means windows-1252.
    ['<meta charset="utf-16">', 'utf-8'],
    ['<meta charset="x-user-defined">', 'windows-1252'],
    ['<meta charset="iso-2022-kr">', 'replacement'],
    // After other tags, comments and a bogus comment.
    [
      '<!doctype html><html lang="ja"><!-- <meta charset="gbk"> --><?x?><meta charset="euc-kr">',
      'euc-kr'
    ]
  ])('finds %s', (html, encoding) => {
    expect(prescanEncoding(bytes(html))).toBe(encoding)
  })

  it.each([
    // content without http-equiv="content-type" is not a declaration.
    '<meta content="text/html; charset=gbk">',
    '<!-- <meta charset="gbk"> -->',
    '<metax charset="gbk">',
    '<meta charset="bogus">',
    '<title><meta charset="gbk"', // runs past the end
    `${' '.repeat(1020)}<meta charset="gbk">`
  ])('finds nothing in %s', html => {
    expect(prescanEncoding(bytes(html))).toBeNull()
  })

  it('lists every declaration in the page, past 1024 bytes and in raw text', () => {
    const page = `<script>'<meta charset="utf-8">'</script>${'<link rel=a href=b>'.repeat(60)}<meta charset="iso-2022-kr"><!-- <meta charset="gbk"> --><p><meta charset=latin1>`
    expect([...declaredEncodings(bytes(page))]).toEqual(['utf-8', 'replacement', 'windows-1252'])
    expect(declaredEncodings(bytes('<p>No declaration</p>')).size).toBe(0)
  })
})

describe('pure ASCII', () => {
  it('needs every byte below 0x80 and no ISO-2022 shift', () => {
    expect(isPureAscii(bytes('<a href="x">badge</a>'))).toBe(true)
    expect(isPureAscii(bytes('café'))).toBe(false)
    for (const shift of [0x1b, 0x0e, 0x0f])
      expect(isPureAscii(new Uint8Array([0x41, shift]))).toBe(false)
  })

  it('counts every encoding but ISO-2022-JP, UTF-16 and replacement as ASCII-compatible', () => {
    for (const encoding of ['utf-8', 'windows-1252', 'shift_jis', 'gb18030', 'x-user-defined']) {
      expect(isAsciiCompatible(encoding), encoding).toBe(true)
    }
    for (const encoding of ['iso-2022-jp', 'utf-16le', 'utf-16be', 'replacement']) {
      expect(isAsciiCompatible(encoding), encoding).toBe(false)
    }
  })
})

describe('decodeHtml', () => {
  it('applies the BOM, then the header, then the prescan, then UTF-8', () => {
    const meta = bytes('<meta charset="windows-1251">é')
    expect(decodeHtml(meta, null)).toMatchObject({ encoding: 'windows-1251', source: 'meta' })
    expect(decodeHtml(meta, 'koi8-r')).toMatchObject({ encoding: 'koi8-r', source: 'header' })
    expect(decodeHtml(meta, 'bogus')).toMatchObject({ encoding: 'windows-1251', source: 'meta' })
    expect(decodeHtml(new Uint8Array([0xef, 0xbb, 0xbf, ...meta]), 'koi8-r')).toEqual({
      encoding: 'utf-8',
      html: '<meta charset="windows-1251">é',
      source: 'bom'
    })
    expect(decodeHtml(bytes('<p>é</p>'), null)).toEqual({
      encoding: 'utf-8',
      html: '<p>é</p>',
      source: 'default'
    })
  })

  it('refuses the replacement encoding', () => {
    expect(decodeHtml(bytes('<a href="x">'), 'iso-2022-kr')).toBeNull()
    expect(decodeHtml(bytes('<meta charset="hz-gb-2312"><a>'), null)).toBeNull()
  })
})

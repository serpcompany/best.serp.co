import { describe, expect, it } from 'vitest'
import { contentTypeEncoding, decodeHtml, encodingForLabel, prescanEncoding } from './html-encoding'

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

describe('Content-Type charset', () => {
  it('reads the first charset parameter, quoted or not', () => {
    expect(contentTypeEncoding('text/html; charset=UTF-16LE')).toBe('utf-16le')
    expect(contentTypeEncoding('text/html;charset="ISO-8859-1"')).toBe('windows-1252')
    expect(contentTypeEncoding('text/html; q="a;b"; charset=euc-kr; charset=utf-8')).toBe('euc-kr')
    expect(contentTypeEncoding('text/html; charset=bogus')).toBeNull()
    expect(contentTypeEncoding('text/html')).toBeNull()
    expect(contentTypeEncoding(null)).toBeNull()
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
})

describe('decodeHtml', () => {
  it('applies the BOM, then the header, then the prescan, then UTF-8', () => {
    const meta = bytes('<meta charset="windows-1251">é')
    expect(decodeHtml(meta, 'text/html')?.encoding).toBe('windows-1251')
    expect(decodeHtml(meta, 'text/html; charset=koi8-r')?.encoding).toBe('koi8-r')
    expect(
      decodeHtml(new Uint8Array([0xef, 0xbb, 0xbf, ...meta]), 'text/html; charset=koi8-r')
    ).toEqual({
      encoding: 'utf-8',
      html: '<meta charset="windows-1251">é'
    })
    expect(decodeHtml(bytes('<p>é</p>'), 'text/html')).toEqual({
      encoding: 'utf-8',
      html: '<p>é</p>'
    })
  })

  it('refuses the replacement encoding', () => {
    expect(decodeHtml(bytes('<a href="x">'), 'text/html; charset=iso-2022-kr')).toBeNull()
    expect(decodeHtml(bytes('<meta charset="hz-gb-2312"><a>'), 'text/html')).toBeNull()
  })
})

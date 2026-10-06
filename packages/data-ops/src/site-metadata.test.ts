import { describe, expect, it } from 'vitest'
import { decodeEntities, iconCandidates, parseSiteMetadata } from './site-metadata'

const page = 'https://www.example.com/en/'
const html = `<!doctype html><html><head>
  <title>Example &amp; Co | Tools</title>
  <meta name="description" content="Fast &lt;tools&gt;.">
  <meta property="og:site_name" content="Example">
  <meta property="og:image" content="/social/card.png">
  <link rel="icon" type="image/svg+xml" href="/icon.svg">
  <link rel="icon" sizes="32x32" href="/favicon-32.png">
  <link rel="icon" sizes="192x192 512x512" href="https://cdn.example.com/icon-512.png">
  <link rel="apple-touch-icon" href="/apple-touch-icon-180.png">
  <link rel="icon" href="http://127.0.0.1/private.png">
  <link rel="icon" href="data:image/png;base64,AAAA">
</head><body><img src="/not-metadata.png"></body></html>`

describe('parseSiteMetadata', () => {
  it('reads the head: title, description, site name, icons, and the social image', () => {
    const metadata = parseSiteMetadata(html, page)
    expect(metadata).toMatchObject({
      description: { source: 'meta description', value: 'Fast <tools>.' },
      ogSiteName: 'Example',
      socialImage: 'https://www.example.com/social/card.png',
      title: 'Example & Co | Tools'
    })
    expect(metadata.icons).toEqual([
      { href: 'https://www.example.com/icon.svg', size: null, touch: false, vector: true },
      { href: 'https://www.example.com/favicon-32.png', size: 32, touch: false, vector: false },
      { href: 'https://cdn.example.com/icon-512.png', size: 512, touch: false, vector: false },
      {
        href: 'https://www.example.com/apple-touch-icon-180.png',
        size: 180,
        touch: true,
        vector: false
      }
    ])
  })

  it('prefers og:image:secure_url, then og:image, then twitter:image', () => {
    const head = (tags: string) => parseSiteMetadata(`<head>${tags}</head>`, page).socialImage
    expect(
      head(
        '<meta name="twitter:image" content="/t.png"><meta property="og:image" content="/o.png"><meta property="og:image:secure_url" content="https://s.example.com/s.png">'
      )
    ).toBe('https://s.example.com/s.png')
    expect(head('<meta name="twitter:image" content="/t.png">')).toBe(
      'https://www.example.com/t.png'
    )
    expect(head('<meta property="og:image" content="http://10.0.0.1/x.png">')).toBeNull()
  })

  it('decodes named and numeric entities', () => {
    expect(decodeEntities('&quot;A&quot; &#8211; &#x2014; &bogus;')).toBe('"A" – — &bogus;')
  })
})

describe('iconCandidates', () => {
  const metadata = parseSiteMetadata(html, page)

  it('keeps submit v2’s defaults: SVG first, 128 px, then /apple-touch-icon.png', () => {
    expect(iconCandidates(metadata, page)).toEqual([
      'https://www.example.com/icon.svg',
      'https://cdn.example.com/icon-512.png',
      'https://www.example.com/apple-touch-icon-180.png',
      'https://www.example.com/apple-touch-icon.png'
    ])
  })

  it('leaves out SVG for hosted media and can fall back to /favicon.ico', () => {
    expect(
      iconCandidates(metadata, page, {
        fallbacks: ['/apple-touch-icon.png', '/favicon.ico'],
        minPixels: 32,
        vector: false
      })
    ).toEqual([
      'https://cdn.example.com/icon-512.png',
      'https://www.example.com/apple-touch-icon-180.png',
      'https://www.example.com/favicon-32.png',
      'https://www.example.com/apple-touch-icon.png',
      'https://www.example.com/favicon.ico'
    ])
  })
})

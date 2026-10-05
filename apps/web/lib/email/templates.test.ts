import { describe, expect, it } from 'vitest'
import { EMAIL_LINK_ORIGINS } from './config'
import {
  createEmailLinks,
  createEmailTemplateRegistry,
  defineEmailTemplate,
  EmailTemplateError,
  escapeHtml,
  html,
  renderEmail,
  SafeHtml
} from './templates'
import { fixtureTemplate } from './test-fixture'

describe('email links', () => {
  it('writes absolute, canonical URLs on each environment origin', () => {
    const cases = [
      ['local', 'http://localhost:8787'],
      ['staging', 'https://best-serp-co-staging.serpcompany.workers.dev'],
      ['production', 'https://best.serp.co']
    ] as const
    for (const [environment, origin] of cases) {
      const links = createEmailLinks(EMAIL_LINK_ORIGINS[environment])
      expect(links.origin).toBe(origin)
      expect(links.url('/')).toBe(origin)
      expect(links.url('/products/autoenhance.ai')).toBe(`${origin}/products/autoenhance.ai/`)
      expect(links.url('/account/?tab=listings#badge')).toBe(
        `${origin}/account/?tab=listings#badge`
      )
      expect(links.url('/robots.txt')).toBe(`${origin}/robots.txt`)
      expect(links.url('/api/auth/callback')).toBe(`${origin}/api/auth/callback`)
    }
  })

  it('refuses anything but a root-relative path', () => {
    const links = createEmailLinks('https://best.serp.co')
    for (const path of [
      'account/',
      '//evil.example/',
      'https://evil.example/',
      'javascript:alert(1)',
      '/\\evil.example',
      '',
      // Whitespace and control characters would split or break the plain-text body.
      '/x\r\ny',
      '/foo bar',
      '/\tevil.example',
      '/a\u0000b',
      '/a\u007fb',
      '/a b'
    ]) {
      expect(() => links.url(path), JSON.stringify(path)).toThrow(EmailTemplateError)
    }
    expect(() => createEmailLinks('https://best.serp.co/')).toThrow(EmailTemplateError)
    // Odd but harmless paths stay on the origin.
    expect(links.url('/@evil.example')).toBe('https://best.serp.co/@evil.example/')
  })
})

describe('html bodies', () => {
  it('escapes every interpolated value unless it is nested html', () => {
    const name = '<script>alert("x")</script> & \'co\''
    const item = (label: string) => html`<li>${label}</li>`
    const body: SafeHtml = html`<p>${name}</p><ul>${['a<b', 'c'].map(item)}</ul>${null}${false}${0}`
    expect(body.toString()).toBe(
      '<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;co&#39;</p><ul><li>a&lt;b</li><li>c</li></ul>0'
    )
    expect(escapeHtml('"&\'<>')).toBe('&quot;&amp;&#39;&lt;&gt;')
  })

  it('accepts only http(s) and mailto URLs in href and src', () => {
    const site = 'https://best.serp.co/products/a.ai/?x=1&y=2'
    expect(html`<a href="${site}">x</a>`.toString()).toBe(
      '<a href="https://best.serp.co/products/a.ai/?x=1&amp;y=2">x</a>'
    )
    expect(html`<a href='${'mailto:support@serp.co'}'>x</a>`.toString()).toBe(
      "<a href='mailto:support@serp.co'>x</a>"
    )
    expect(html`<img src="${'http://localhost:8787/logo.png'}" alt="">`.toString()).toContain(
      'src="http://localhost:8787/logo.png"'
    )
    for (const value of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      ' javascript:alert(1)',
      'java\tscript:alert(1)',
      'data:text/html;base64,PHNjcmlwdD4=',
      'vbscript:x',
      '/relative/path',
      '//evil.example/',
      'not a url'
    ]) {
      expect(() => html`<a href="${value}">x</a>`, value).toThrow(EmailTemplateError)
      expect(() => html`<img SRC = "${value}">`, value).toThrow(EmailTemplateError)
    }
    expect(() => html`<a href="${html`https://best.serp.co`}">x</a>`).toThrow(EmailTemplateError)
  })

  it('refuses a value in an unquoted attribute', () => {
    expect(() => html`<td width=${'100 onmouseover=alert(1)'}>x</td>`).toThrow(EmailTemplateError)
    expect(() => html`<a href=${'https://best.serp.co'}>x</a>`).toThrow(EmailTemplateError)
    expect(() => html`<a ${'onclick=alert(1)'}>x</a>`).toThrow(EmailTemplateError)
    // Browsers strip leading spaces from URLs, so the value still picks the scheme here.
    expect(() => html`<a href=" ${'javascript:alert(1)'}">x</a>`).toThrow(EmailTemplateError)
    expect(() => html`<p title="${html`<b>x</b>`}">x</p>`).toThrow(EmailTemplateError)
    // Once the literal fixes the scheme, a value must be one encoded URL component.
    expect(
      html`<a href="https://best.serp.co/products/${encodeURIComponent('a"b<c')}/" title="${'Tom & Jerry'}">x</a>`.toString()
    ).toBe('<a href="https://best.serp.co/products/a%22b%3Cc/" title="Tom &amp; Jerry">x</a>')
    expect(() => html`<a href="https://best.serp.co/products/${'a"b'}/">x</a>`).toThrow(
      EmailTemplateError
    )
    // An equals sign in text content is fine.
    expect(html`<p>1 + 1 = ${2}</p>`.toString()).toBe('<p>1 + 1 = 2</p>')
  })

  it('tracks quotes from the start, so an earlier quoted > cannot hide a link', () => {
    expect(() => html`<a title="a>b" href="${'javascript:alert(1)'}">x</a>`).toThrow(
      EmailTemplateError
    )
    expect(() => html`<a title='a>"b' href="${'javascript:alert(1)'}">x</a>`).toThrow(
      EmailTemplateError
    )
    expect(() => html`<a title="a>b" href="${html`x" onmouseover="alert(1)`}">x</a>`).toThrow(
      EmailTemplateError
    )
    // A nested fragment that leaves a tag open is tracked too.
    const open = html`<a title="x`
    expect(() => html`${open}" href="${'javascript:alert(1)'}">y</a>`).toThrow(EmailTemplateError)
    // Quotes and > in text content don't start an attribute.
    expect(html`<p>"a > b" ${'c'}</p>`.toString()).toBe('<p>"a > b" c</p>')
    expect(html`<p>${'a'}</p><a href="${'https://best.serp.co'}">x</a>`.toString()).toBe(
      '<p>a</p><a href="https://best.serp.co">x</a>'
    )
  })

  it('checks every URL attribute and refuses values in style, handlers, and raw text', () => {
    const bad = 'javascript:alert(1)'
    expect(() => html`<td background="${bad}">x</td>`).toThrow(EmailTemplateError)
    expect(() => html`<form action="${bad}"></form>`).toThrow(EmailTemplateError)
    expect(() => html`<button formaction="${bad}">x</button>`).toThrow(EmailTemplateError)
    expect(() => html`<video poster="${bad}"></video>`).toThrow(EmailTemplateError)
    expect(() => html`<q cite="${bad}">x</q>`).toThrow(EmailTemplateError)
    expect(() => html`<img SRCSET="${bad}">`).toThrow(EmailTemplateError)
    expect(() => html`<form action="${'data:text/html,x'}"></form>`).toThrow(EmailTemplateError)
    expect(html`<td background="${'https://best.serp.co/bg.png'}">x</td>`.toString()).toBe(
      '<td background="https://best.serp.co/bg.png">x</td>'
    )
    expect(() => html`<p style="background:url(${'https://best.serp.co/x.png'})">x</p>`).toThrow(
      EmailTemplateError
    )
    expect(() => html`<p style="${'color: red'}">x</p>`).toThrow(EmailTemplateError)
    expect(() => html`<p onclick="${'x'}">x</p>`).toThrow(EmailTemplateError)
    expect(() => html`<style>p { color: ${'red'} }</style>`).toThrow(EmailTemplateError)
    expect(() => html`<script>${'1'}</script>`).toThrow(EmailTemplateError)
    expect(() => html`<!-- ${'note'} -->`).toThrow(EmailTemplateError)
    // After a raw-text element closes, content is text again.
    expect(html`<style>p { color: red }</style><p>${'a<b'}</p>`.toString()).toBe(
      '<style>p { color: red }</style><p>a&lt;b</p>'
    )
  })

  it('accepts only mailto links to one plain address', () => {
    expect(html`<a href="${'mailto:support@serp.co'}">x</a>`.toString()).toBe(
      '<a href="mailto:support@serp.co">x</a>'
    )
    for (const value of [
      'mailto:support@serp.co?bcc=attacker@example.com',
      'mailto:support@serp.co%0D%0ABcc:attacker@example.com',
      'mailto:support@serp.co\r\nBcc: attacker@example.com',
      'mailto:a@b.co,c@d.co',
      'mailto:?to=a@b.co',
      'mailto:'
    ]) {
      expect(() => html`<a href="${value}">x</a>`, JSON.stringify(value)).toThrow(
        EmailTemplateError
      )
    }
    // A value after a literal `mailto:` must be encoded, so it can't add a query.
    expect(() => html`<a href="mailto:${'support@serp.co?bcc=x@y.co'}">x</a>`).toThrow(
      EmailTemplateError
    )
  })

  it('refuses a hand-built strings array', () => {
    const forged = Object.assign(['<img src=x onerror=alert(1)>'], {
      raw: ['<img src=x onerror=alert(1)>']
    }) as unknown as TemplateStringsArray
    expect(() => html(forged)).toThrow(EmailTemplateError)
    expect(() => html(Object.freeze(forged))).toThrow(EmailTemplateError)
    expect(() => html(['<b>'] as unknown as TemplateStringsArray)).toThrow(EmailTemplateError)
  })

  it('mints SafeHtml only through the html tag', () => {
    const Constructor = SafeHtml as unknown as new (mint: symbol, markup: string) => SafeHtml
    expect(() => new Constructor(Symbol('SafeHtml'), '<img src=x onerror=alert(1)>')).toThrow(
      EmailTemplateError
    )
    const forged = Object.create(SafeHtml.prototype) as SafeHtml
    expect(SafeHtml.is(forged)).toBe(false)
    expect(SafeHtml.is(html`<p>x</p>`)).toBe(true)
    expect('fromTrustedMarkup' in SafeHtml).toBe(false)
  })
})

describe('template contract', () => {
  const context = (origin: string) => ({
    environment: 'production' as const,
    links: createEmailLinks(origin),
    supportAddress: 'support@serp.co'
  })

  it('renders a subject, a plain-text body, and an HTML body with absolute links', () => {
    const rendered = renderEmail(
      fixtureTemplate,
      { path: '/products/autoenhance.ai', title: 'Tom & Jerry <3' },
      context('https://best.serp.co')
    )
    expect(rendered).toEqual({
      html: '<p>Tom &amp; Jerry &lt;3</p><p><a href="https://best.serp.co/products/autoenhance.ai/">https://best.serp.co/products/autoenhance.ai/</a></p><p>support@serp.co</p>',
      subject: 'Fixture: Tom & Jerry <3',
      text: 'Tom & Jerry <3\n\nhttps://best.serp.co/products/autoenhance.ai/\n\nsupport@serp.co'
    })
    const staging = renderEmail(
      fixtureTemplate,
      { path: '/account', title: 'x' },
      context(EMAIL_LINK_ORIGINS.staging)
    )
    expect(staging.text).toContain('https://best-serp-co-staging.serpcompany.workers.dev/account/')
  })

  it('keeps subjects on one line and refuses empty or unescaped output', () => {
    const template = (content: { html: unknown; subject: string; text: string }) =>
      defineEmailTemplate<null>({
        id: 'contract-check',
        render: () => content as { html: SafeHtml; subject: string; text: string }
      })
    const ok = { html: html`<p>x</p>`, text: 'x' }
    expect(
      renderEmail(
        template({ ...ok, subject: ' Line one\r\nBcc: x@y.co ' }),
        null,
        context('https://best.serp.co')
      ).subject
    ).toBe('Line one Bcc: x@y.co')
    for (const content of [
      { ...ok, subject: ' \n ' },
      { ...ok, subject: 'x'.repeat(201) },
      { ...ok, subject: 's', text: '  ' },
      { html: html``, subject: 's', text: 'x' },
      { html: '<p>raw</p>', subject: 's', text: 'x' },
      { html: Object.create(SafeHtml.prototype), subject: 's', text: 'x' }
    ]) {
      expect(() => renderEmail(template(content), null, context('https://best.serp.co'))).toThrow(
        EmailTemplateError
      )
    }
  })

  it('registers each template under its own, well-formed id', () => {
    expect(createEmailTemplateRegistry({ 'test-fixture': fixtureTemplate })['test-fixture']).toBe(
      fixtureTemplate
    )
    expect(() => createEmailTemplateRegistry({ other: fixtureTemplate })).toThrow(
      EmailTemplateError
    )
    expect(() =>
      defineEmailTemplate({
        id: 'Bad Id',
        render: () => ({ html: html`x`, subject: 's', text: 't' })
      })
    ).toThrow(EmailTemplateError)
  })
})

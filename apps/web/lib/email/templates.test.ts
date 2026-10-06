import { describe, expect, it } from 'vitest'
import { EMAIL_LINK_ORIGINS } from './config'
import {
  createEmailLinks,
  createEmailTemplateRegistry,
  css,
  defineEmailTemplate,
  EmailTemplateError,
  escapeHtml,
  html,
  renderEmail,
  SafeCss,
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
    expect(html`<a href='${'mailto:help@example.com'}'>x</a>`.toString()).toBe(
      "<a href='mailto:help@example.com'>x</a>"
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
    expect(html`<a href="${'mailto:help@example.com'}">x</a>`.toString()).toBe(
      '<a href="mailto:help@example.com">x</a>'
    )
    for (const value of [
      'mailto:help@example.com?bcc=attacker@example.com',
      'mailto:help@example.com%0D%0ABcc:attacker@example.com',
      'mailto:help@example.com\r\nBcc: attacker@example.com',
      'mailto:a@b.co,c@d.co',
      'mailto:?to=a@b.co',
      'mailto:'
    ]) {
      expect(() => html`<a href="${value}">x</a>`, JSON.stringify(value)).toThrow(
        EmailTemplateError
      )
    }
    // A value after a literal `mailto:` must be encoded, so it can't add a query.
    expect(() => html`<a href="mailto:${'help@example.com?bcc=x@y.co'}">x</a>`).toThrow(
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

  it('accepts the address after a literal mailto:', () => {
    expect(html`<a href="mailto:${'help@example.com'}">x</a>`.toString()).toBe(
      '<a href="mailto:help@example.com">x</a>'
    )
    for (const value of ['help@example.com?bcc=x@y.co', 'a@b.co,c@d.co', 'not-an-address', '']) {
      expect(() => html`<a href="mailto:${value}">x</a>`, value).toThrow(EmailTemplateError)
    }
  })

  it('takes inline styles only from css(), with allowlisted properties and values', () => {
    const tokens = { ink: '#0f172a', font: "'Helvetica Neue', Arial, sans-serif" }
    expect(
      html`<td style="${css({ color: tokens.ink, 'font-family': tokens.font, padding: '12px 24px' })}">x</td>`.toString()
    ).toBe(
      '<td style="color:#0f172a;font-family:&#39;Helvetica Neue&#39;, Arial, sans-serif;padding:12px 24px">x</td>'
    )
    expect(
      html`<td style="display:block; ${css({ 'border-radius': 6, border: '1px solid #e5e5e5' })}">x</td>`.toString()
    ).toBe('<td style="display:block; border-radius:6;border:1px solid #e5e5e5">x</td>')
    for (const [property, value] of [
      ['color', 'red;background:url(https://evil.example/t)'],
      ['color', 'expression(alert(1))'],
      ['background-color', 'url(https://evil.example/t)'],
      ['font-family', 'x\\'],
      ['width', '1px /* */'],
      ['behavior', 'none'],
      ['background-image', 'none'],
      ['color', '']
    ]) {
      expect(() => css({ [property as string]: value as string }), `${property}: ${value}`).toThrow(
        EmailTemplateError
      )
    }
    expect(() => html`<td style="${'color: red'}">x</td>`).toThrow(EmailTemplateError)
    expect(() => html`<td style="color:${css({ color: '#fff' })}">x</td>`).toThrow(
      EmailTemplateError
    )
    expect(() => html`<p>${css({ color: '#fff' })}</p>`).toThrow(EmailTemplateError)
    expect(() => html`<p title="${css({ color: '#fff' })}">x</p>`).toThrow(EmailTemplateError)
  })

  it('accepts a srcset with several whole http(s) URLs', () => {
    const a = 'https://best.serp.co/logo.png'
    const b = 'https://best.serp.co/logo@2x.png'
    expect(html`<img src="${a}" srcset="${a} 1x, ${b} 2x" alt="">`.toString()).toBe(
      `<img src="${a}" srcset="${a} 1x, ${b} 2x" alt="">`
    )
    expect(() => html`<img srcset="${a} 1x, ${'javascript:alert(1)'} 2x">`).toThrow(
      EmailTemplateError
    )
    expect(() => html`<img srcset="${'mailto:a@b.co'} 1x">`).toThrow(EmailTemplateError)
    expect(() => html`<img srcset="https://best.serp.co/${'x.png'} 1x">`).toThrow(
      EmailTemplateError
    )
  })

  it('refuses Outlook conditional comments with a pointer to table buttons', () => {
    expect(
      () =>
        html`<!--[if mso]><v:roundrect href="${'https://best.serp.co'}"></v:roundrect><![endif]-->`
    ).toThrow(/table-based button/u)
  })

  it('ends raw text only at a real end tag', () => {
    expect(
      () => html`<style>p{}</styles>${'x}body{background:url(https://evil.example/t)}'}`
    ).toThrow(EmailTemplateError)
    expect(() => html`<style>p{}</style${'x'}`).toThrow(EmailTemplateError)
    expect(html`<style>p{}</style ><p>${'a'}</p>`.toString()).toBe('<style>p{}</style ><p>a</p>')
  })

  it('accepts a value after a literal scheme only for http(s) and mailto', () => {
    expect(() => html`<a href="javascript:${'alert(1)'}">x</a>`).toThrow(EmailTemplateError)
    expect(() => html`<a href="data:text/html,${'x'}">x</a>`).toThrow(EmailTemplateError)
    expect(() => html`<a href="vbscript:${'x'}">x</a>`).toThrow(EmailTemplateError)
    expect(
      html`<a href="https://best.serp.co/?q=${encodeURIComponent('a b')}">x</a>`.toString()
    ).toBe('<a href="https://best.serp.co/?q=a%20b">x</a>')
  })

  it('refuses values in meta, base, link, svg, and math', () => {
    const bad = 'javascript:alert(1)'
    expect(() => html`<meta http-equiv="refresh" content="0;url=${bad}">`).toThrow(
      EmailTemplateError
    )
    expect(() => html`<base href="${'https://evil.example/'}">`).toThrow(EmailTemplateError)
    expect(() => html`<link rel="stylesheet" href="${'https://evil.example/x.css'}">`).toThrow(
      EmailTemplateError
    )
    expect(() => html`<svg><animate attributeName="href" values="${bad}"/></svg>`).toThrow(
      EmailTemplateError
    )
    expect(() => html`<svg><set attributeName="href" to="${bad}"/></svg>`).toThrow(
      EmailTemplateError
    )
    expect(() => html`<svg width="${'10'}"></svg>`).toThrow(EmailTemplateError)
    expect(() => html`<svg><text>${'a'}</text></svg>`).toThrow(EmailTemplateError)
    expect(() => html`<math><mi>${'x'}</mi></math>`).toThrow(EmailTemplateError)
    // After the foreign element closes, content is ordinary text again.
    expect(html`<svg></svg><p>${'a'}</p>`.toString()).toBe('<svg></svg><p>a</p>')
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
    const CssConstructor = SafeCss as unknown as new (mint: symbol, value: string) => SafeCss
    expect(() => new CssConstructor(Symbol('SafeHtml'), 'background:url(x)')).toThrow(
      EmailTemplateError
    )
  })
})

describe('template contract', () => {
  const context = (origin: string) => ({
    dashboardUrl: `${origin}/account/`,
    environment: 'production' as const,
    links: createEmailLinks(origin)
  })

  it('renders a subject, a plain-text body, and an HTML body with absolute links', () => {
    const rendered = renderEmail(
      fixtureTemplate,
      { path: '/products/autoenhance.ai', title: 'Tom & Jerry <3' },
      context('https://best.serp.co')
    )
    expect(rendered).toEqual({
      html: '<p>Tom &amp; Jerry &lt;3</p><p><a href="https://best.serp.co/products/autoenhance.ai/">https://best.serp.co/products/autoenhance.ai/</a></p><p><a href="https://best.serp.co/account/">https://best.serp.co/account/</a></p>',
      subject: 'Fixture: Tom & Jerry <3',
      text: 'Tom & Jerry <3\n\nhttps://best.serp.co/products/autoenhance.ai/\n\nhttps://best.serp.co/account/'
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
    const footer = 'https://best.serp.co/account/'
    const ok = { html: html`<p><a href="${footer}">x</a></p>`, text: `x ${footer}` }
    expect(
      renderEmail(
        template({ ...ok, subject: ' Line one\r\nBcc: x@y.co ' }),
        null,
        context('https://best.serp.co')
      ).subject
    ).toBe('Line one Bcc: x@y.co')
    // An overlong subject is shortened with an ellipsis instead of dropping the email.
    const long = renderEmail(
      template({ ...ok, subject: 'x'.repeat(250) }),
      null,
      context('https://best.serp.co')
    ).subject
    expect(long).toBe(`${'x'.repeat(199)}…`)
    // An exact link passes with either quote and other attributes, and the text URL may end a
    // sentence.
    for (const content of [
      {
        html: html`<a class="f" href='${footer}' title="x">x</a>`,
        subject: 's',
        text: `(${footer}).`
      },
      { html: html`<p><a href="${footer}">x</a></p>`, subject: 's', text: `Reply: ${footer}` }
    ]) {
      expect(() =>
        renderEmail(template(content), null, context('https://best.serp.co'))
      ).not.toThrow()
    }
    for (const content of [
      { ...ok, subject: ' \n ' },
      { ...ok, subject: 's', text: '  ' },
      { html: html``, subject: 's', text: 'x' },
      { html: '<p>raw</p>', subject: 's', text: 'x' },
      { html: Object.create(SafeHtml.prototype), subject: 's', text: 'x' },
      // Every footer links to the dashboard, in both bodies.
      { html: html`<p>x</p>`, subject: 's', text: `x ${footer}` },
      { ...ok, subject: 's', text: 'x' },
      // A link to a page under the dashboard is not the dashboard link.
      {
        html: html`<a href="${`${footer}settings/`}">x</a>`,
        subject: 's',
        text: `x ${footer}settings/`
      },
      // The URL in an alt attribute, with no link.
      {
        html: html`<img alt="${footer}" src="${footer}logo.png">`,
        subject: 's',
        text: `x ${footer}`
      },
      // The URL inside another link's query.
      {
        html: html`<a href="${`https://evil.example/?${footer}`}">x</a>`,
        subject: 's',
        text: `see https://evil.example/?${footer}`
      }
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

/**
 * The PR #84 round-2 differential cases: each badge page and the verdict Chromium 147's parser
 * gave it (scripting on, as for Googlebot), served at `PAGE` inside
 * `<!doctype html><html><head></head><body>…</body></html>`. Generated from the reviewer's
 * harness; Chromium is the ground truth the scanner must never be more permissive than.
 */
export const L = 'https://best.serp.co/products/example.com/'
export const B = 'https://best.serp.co/badge/featured-on-serp.co-light.svg'
export const E = 'https://evil.example/'
export const PAGE = 'https://site.example/dir/page.html'

export type ChromiumVerdict =
  | 'badge_missing'
  | 'link_not_followed'
  | 'ok'
  | 'page_not_followed'
  | 'wrong_destination'

export const DIFFERENTIAL_CASES: ReadonlyArray<{
  chromium: ChromiumVerdict
  html: string
  name: string
}> = [
  { chromium: 'ok', html: `<a href="${L}"><img src="${B}"></a>`, name: 'plain' },
  {
    chromium: 'badge_missing',
    html: `<script><!--<script></script><a href="${L}"><img src="${B}"></a>--></script>`,
    name: 'scriptDoubleEscape'
  },
  {
    chromium: 'badge_missing',
    html: `<script><!--<script>x</script><a href="${L}"><img src="${B}"></a></script>`,
    name: 'scriptDoubleEscapeNoClose'
  },
  {
    chromium: 'badge_missing',
    html: `<script><!--<SCRIPT ></script><a href="${L}"><img src="${B}"></a></script>`,
    name: 'scriptDoubleEscapeUpper'
  },
  {
    chromium: 'ok',
    html: `<script><!--</script><a href="${L}"><img src="${B}"></a>-->`,
    name: 'scriptEscapedOnly'
  },
  {
    chromium: 'badge_missing',
    html: `<svg><![CDATA[><p><a href="${L}"><img src="${B}"></a>]]></svg>`,
    name: 'cdataForeignBreakout'
  },
  {
    chromium: 'badge_missing',
    html: `<a href="${L}"><svg><![CDATA[><img src="${B}">]]></svg></a>`,
    name: 'cdataForeignImg'
  },
  {
    chromium: 'wrong_destination',
    html: `<![CDATA[<a href="${L}"><img src="${B}"></a>]]>`,
    name: 'cdataHtml'
  },
  {
    chromium: 'wrong_destination',
    html: `<svg width=10/><a href="${L}"><img src="${B}"></a></svg>`,
    name: 'svgSelfCloseUnquoted'
  },
  {
    chromium: 'wrong_destination',
    html: `<a href="${L}"><svg></a><img src="${B}">`,
    name: 'svgEndA'
  },
  {
    chromium: 'ok',
    html: `<a href="${L}"><svg><title></a></title></svg><img src="${B}">`,
    name: 'svgTitleEndA'
  },
  {
    chromium: 'wrong_destination',
    html: `<svg><base href="${L}"></base></svg><a href=""><img src="${B}"></a>`,
    name: 'svgBase'
  },
  {
    chromium: 'ok',
    html: `<a href="${L}"><svg><a href="${E}"></a></svg><img src="${B}"></a>`,
    name: 'svgInnerA'
  },
  {
    chromium: 'ok',
    html: `<a href="${L}"><svg><title><img src="${B}"></title></svg></a>`,
    name: 'svgTitleImg'
  },
  {
    chromium: 'ok',
    html: `<svg><foreignObject><a href="${L}"><img src="${B}"></a></foreignObject></svg>`,
    name: 'foreignObject'
  },
  {
    chromium: 'ok',
    html: `<math><mi><a href="${L}"><img src="${B}"></a></mi></math>`,
    name: 'mathMi'
  },
  {
    chromium: 'ok',
    html: `<svg><font color="red"></font><a href="${L}"><img src="${B}"></a></svg>`,
    name: 'fontBreakout'
  },
  {
    chromium: 'ok',
    html: `<base href="https://best.serp.co/"><a href="/products/example.com/"><img src="/badge/featured-on-serp.co-light.svg"></a>`,
    name: 'baseRelative'
  },
  {
    chromium: 'ok',
    html: `<a href="/products/example.com/"><img src="${B}"></a><base href="https://best.serp.co/">`,
    name: 'baseAfterAnchor'
  },
  {
    chromium: 'wrong_destination',
    html: `<template><base href="https://best.serp.co/"></template><a href="/products/example.com/"><img src="${B}"></a>`,
    name: 'baseInTemplate'
  },
  {
    chromium: 'wrong_destination',
    html: `<base href="${E}"><base href="https://best.serp.co/"><a href="/products/example.com/"><img src="${B}"></a>`,
    name: 'baseTwo'
  },
  {
    chromium: 'ok',
    html: `<base target="_blank"><base href="https://best.serp.co/"><a href="/products/example.com/"><img src="${B}"></a>`,
    name: 'baseNoHrefThenHref'
  },
  {
    chromium: 'ok',
    html: `<select><a href="${L}"><img src="${B}"></a></select>`,
    name: 'selectWrap'
  },
  {
    chromium: 'ok',
    html: `<select><option><a href="${L}"><img src="${B}"></a></option></select>`,
    name: 'selectOption'
  },
  {
    chromium: 'ok',
    html: `<a href="${L}"><img src="${B}"></a><!-- unclosed`,
    name: 'unclosedCommentAfter'
  },
  {
    chromium: 'badge_missing',
    html: `<!-- unclosed <a href="${L}"><img src="${B}"></a>`,
    name: 'unclosedCommentBefore'
  },
  { chromium: 'ok', html: `<!--><a href="${L}"><img src="${B}"></a>`, name: 'commentAbrupt' },
  { chromium: 'ok', html: `<!---><a href="${L}"><img src="${B}"></a>`, name: 'commentAbrupt2' },
  { chromium: 'ok', html: `<!-- x --!><a href="${L}"><img src="${B}"></a>`, name: 'commentBang' },
  {
    chromium: 'badge_missing',
    html: `<!-- -- ><a href="${L}"><img src="${B}"></a> -->`,
    name: 'commentDashSpace'
  },
  {
    chromium: 'ok',
    html: `<!-- <!-- --><a href="${L}"><img src="${B}"></a>`,
    name: 'commentNested'
  },
  {
    chromium: 'wrong_destination',
    html: `<?php <a href="${L}"><img src="${B}"></a> ?>`,
    name: 'bogusPi'
  },
  {
    chromium: 'wrong_destination',
    html: `<a href="${L}"><a href="${E}"><img src="${B}"></a></a>`,
    name: 'nestedAInner'
  },
  {
    chromium: 'ok',
    html: `<a href="${E}"><a href="${L}"><img src="${B}"></a></a>`,
    name: 'nestedAOuter'
  },
  {
    chromium: 'wrong_destination',
    html: `<a href="${L}"><div><a href="${E}">x</a><img src="${B}"></div></a>`,
    name: 'adoptionDiv'
  },
  { chromium: 'ok', html: `<p><a href="${L}">text</p><img src="${B}">`, name: 'pReconstruct' },
  {
    chromium: 'wrong_destination',
    html: `<a HREF="${E}" href="${L}"><img src="${B}"></a>`,
    name: 'dupAttrCase'
  },
  {
    chromium: 'link_not_followed',
    html: `<a href="${L}" REL="nofollow" rel="noopener"><img src="${B}"></a>`,
    name: 'dupRelCase'
  },
  {
    chromium: 'wrong_destination',
    html: `<a &#104;ref="${L}"><img src="${B}"></a>`,
    name: 'entityAttrName'
  },
  {
    chromium: 'wrong_destination',
    html: `<a href rel href="${L}"><img src="${B}"></a>`,
    name: 'attrNoValueFirst'
  },
  { chromium: 'ok', html: `<a href="${L}" rel><img src="${B}"></a>`, name: 'attrNoValueRel' },
  {
    chromium: 'ok',
    html: `<a href="${L}"><picture><source srcset="${E}x.png"><img src="${B}"></picture></a>`,
    name: 'pictureSource'
  },
  {
    chromium: 'ok',
    html: `<a href="${L}"><img src="${B}" srcset="${E}x.png 1x"></a>`,
    name: 'srcsetSwap'
  },
  {
    chromium: 'badge_missing',
    html: `<a href="${L}"><noscript><img src="${B}"></noscript></a>`,
    name: 'noscriptImg'
  },
  { chromium: 'ok', html: `<a href="${L}"><image src="${B}"></a>`, name: 'imageAlias' },
  {
    chromium: 'badge_missing',
    html: `<a href="${L}"><svg><image href="${B}"/></svg></a>`,
    name: 'svgImageEl'
  },
  {
    chromium: 'wrong_destination',
    html: `<svg><a href="${L}"><img src="${B}"></a></svg>`,
    name: 'svgAImg'
  },
  {
    chromium: 'badge_missing',
    html: `<template><template></template><a href="${L}"><img src="${B}"></a></template>`,
    name: 'templateNested'
  },
  {
    chromium: 'ok',
    html: `</template><a href="${L}"><img src="${B}"></a>`,
    name: 'strayTemplateEnd'
  },
  {
    chromium: 'ok',
    html: `<a href="${L}" title="</a>"><img src="${B}"></a>`,
    name: 'attrValueEndA'
  },
  {
    chromium: 'ok',
    html: `<table><a href="${L}"><img src="${B}"></a></table>`,
    name: 'tableFoster'
  },
  {
    chromium: 'badge_missing',
    html: `<plaintext><a href="${L}"><img src="${B}"></a>`,
    name: 'plaintext'
  },
  {
    chromium: 'ok',
    html: `<script>x</script ><a href="${L}"><img src="${B}"></a>`,
    name: 'rawEndSpace'
  },
  {
    chromium: 'badge_missing',
    html: `<script>x</scriptx><a href="${L}"><img src="${B}"></a></script>`,
    name: 'rawEndFake'
  },
  {
    chromium: 'ok',
    html: `<style><!--</style><a href="${L}"><img src="${B}"></a>-->`,
    name: 'styleComment'
  },
  {
    chromium: 'ok',
    html: `<textarea><!--</textarea><a href="${L}"><img src="${B}"></a>-->`,
    name: 'textareaComment'
  },
  {
    chromium: 'badge_missing',
    html: `<title><a href="${L}"><img src="${B}"></a></title>`,
    name: 'titleRaw'
  },
  {
    chromium: 'badge_missing',
    html: `<iframe><a href="${L}"><img src="${B}"></a></iframe>`,
    name: 'iframeRaw'
  },
  {
    chromium: 'badge_missing',
    html: `<xmp><a href="${L}"><img src="${B}"></a></xmp>`,
    name: 'xmpRaw'
  },
  {
    chromium: 'badge_missing',
    html: `<script type="text/template"><a href="${L}"><img src="${B}"></a></script>`,
    name: 'scriptTemplateType'
  },
  { chromium: 'ok', html: `<a href="${L}"/><img src="${B}">`, name: 'selfClosingA' },
  { chromium: 'ok', html: `<A HREF="${L}"><IMG SRC="${B}"></A>`, name: 'upper' },
  {
    chromium: 'wrong_destination',
    html: `<a\u0000 href="${L}"><img src="${B}"></a>`,
    name: 'nullInTagName'
  },
  { chromium: 'ok', html: `<a href=${L}><img src=${B}></a>`, name: 'unquotedSlash' },
  { chromium: 'badge_missing', html: `<a href="${L}><img src="${B}"></a>`, name: 'unclosedQuote' },
  { chromium: 'ok', html: `<a href="  ${L}  "><img src="${B}"></a>`, name: 'hrefSpaces' },
  {
    chromium: 'ok',
    html: `<a href="https://best.serp.co/prod&#9;ucts/example.com/"><img src="${B}"></a>`,
    name: 'hrefTab'
  },
  {
    chromium: 'ok',
    html: `<a href="https&colon;&sol;&sol;best.serp.co/products/example.com/"><img src="${B}"></a>`,
    name: 'hrefSolEntity'
  },
  {
    chromium: 'ok',
    html: `<a href="${L}" rel="nofollow&nbsp;x"><img src="${B}"></a>`,
    name: 'relNoFollowNbsp'
  },
  {
    chromium: 'ok',
    html: `<a href="${L}"><object data="${E}x.swf"><img src="${B}"></object></a>`,
    name: 'objectFallback'
  },
  {
    chromium: 'ok',
    html: `<script>document.write('<a href="${L}"><img src="${B}"></a>')</script>`,
    name: 'docWrite'
  },
  {
    chromium: 'page_not_followed',
    html: `<meta name="robots" content="none"><a href="${L}"><img src="${B}"></a>`,
    name: 'robotsNone'
  },
  {
    chromium: 'ok',
    html: `<meta name="robots" content="noindex"><a href="${L}"><img src="${B}"></a>`,
    name: 'robotsNoindexOnly'
  },
  {
    chromium: 'ok',
    html: `<meta name="otherbot" content="nofollow"><a href="${L}"><img src="${B}"></a>`,
    name: 'robotsOtherBot'
  },
  {
    chromium: 'ok',
    html: `<template><meta name="robots" content="nofollow"></template><a href="${L}"><img src="${B}"></a>`,
    name: 'robotsInTemplate'
  },
  {
    chromium: 'page_not_followed',
    html: `<svg><meta name="robots" content="nofollow"></svg><a href="${L}"><img src="${B}"></a>`,
    name: 'robotsInSvg'
  },
  { chromium: 'ok', html: `<a href="${L}" <x><img src="${B}"></a>`, name: 'ltAttrName' },
  {
    chromium: 'ok',
    html: `<a href="${L}"><table><tr><td><img src="${B}"></td></tr></table></a>`,
    name: 'imgInsideALaterClosedByTable'
  },
  {
    chromium: 'ok',
    html: `<button><a href="${L}"><img src="${B}"></a></button>`,
    name: 'aInsideButton'
  },
  { chromium: 'ok', html: `<a href="${L}"><form><img src="${B}"></form></a>`, name: 'formInA' },
  { chromium: 'ok', html: `<ul><li><a href="${L}"><li><img src="${B}"></ul>`, name: 'liClosesA' }
]

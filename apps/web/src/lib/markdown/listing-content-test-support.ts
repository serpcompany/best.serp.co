/**
 * Listing bodies for the content tree tests (#334): every Markdown construct a body can hold,
 * including the ones react-markdown rewrites (raw HTML, unsafe URLs) or GitHub-flavored Markdown
 * adds (tables, footnotes, task lists, autolinks, strikethrough). Hosts are `.test` (#311).
 */
export const KITCHEN_SINK_BODY = String.raw`# Fixture Studio Review

Fixture Studio is **bold**, *italic*, ***both***, ~~struck~~ and ${'`inline code`'}, with a hard
break
here and a backslash break\
too. Entities: &amp; &copy; &lt;tag&gt; &#169; and a bare < and &. Emoji: 🎨 ✓ “quotes”.

## What this page shows

Links: [inline](https://studio.test/a "With a title"), [relative](/products/fixture-relay/),
[anchor](#what-this-page-shows), [mail](mailto:hello@studio.test),
[short link](https://serp.ly/fixture-studio), [short link with query](https://serp.ly/x?y=1#z),
[already tagged](https://serp.ly/a?via=other), [script](javascript:alert(1)), [reference][ref],
<https://auto.test/path>, www.literal.test, https://bare.test/x?y=1 and hello@studio.test.

[ref]: https://ref.test/page "Ref title"

### Tables

| Left | Center | Right | Default |
| :--- | :----: | ----: | ------- |
| ${'`code`'} | **bold** | [link](https://t.test/) | a \| pipe |
| 1 | 2 | 3 | |
| *emphasis* and ~~strike~~ | x | y | z |

#### Heading four ####

##### Heading five

###### Heading six

> A quote with **bold** and a [link](https://quote.test/).
>
> > Nested.

1. First
2. Second
   - nested ${'`code`'}
     1. deep
3. Third

5. Starts at five
6. Six

- [ ] open task
- [x] done task

${'```'}ts
const answer: number = 42 // <not html>
${'```'}

    indented code

![Alt text](https://img.test/a.png "Image title")
![](/relative.png)

<div class="raw">Raw HTML block</div>

Inline <span>raw html</span>, a <br> and <!-- a comment -->.

A footnote[^1] and another[^note].

[^1]: The footnote, with a [link](https://fn.test/).
[^note]: A named footnote.

---

Setext heading
==============

## Links

- [Repeated in the resource links](https://studio.test/links)
`

/** A body shaped like the catalog's: sections of prose, a list, and a "Links" section. */
export const REVIEW_BODY = [
  'Inkwell helps teams review drafts in one place, with **shared notes** and history.',
  '',
  '## Core Features',
  '',
  'Inkwell keeps every draft in sync. See [the guide](https://docs.inkwell.test/start) or',
  '[our review](https://serp.ly/inkwell) for more.',
  '',
  '- **Fast search**: find any draft.',
  '- **Exports**: PDF and Markdown.',
  '',
  '## Pricing',
  '',
  '| Plan | Price |',
  '| --- | ---: |',
  '| Free | $0 |',
  '| Pro | $12/mo |',
  '',
  '## Links',
  '',
  '- [Home](https://inkwell.test/)'
].join('\n')

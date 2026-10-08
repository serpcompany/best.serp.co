import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { faqsToShow, WebsiteFaqsSection } from './website-faqs-section'

// This package's tests compile JSX with the classic runtime, which reads a global React.
Object.assign(globalThis, { React })

describe('listing FAQs (#105)', () => {
  it('renders nothing without FAQs', () => {
    expect(WebsiteFaqsSection({ website: {} })).toBeNull()
    expect(WebsiteFaqsSection({ website: { faqs: [] } })).toBeNull()
  })

  it('renders each question and keeps closed answers in the HTML', () => {
    const html = renderToStaticMarkup(
      React.createElement(WebsiteFaqsSection, {
        website: {
          faqs: [
            {
              answer: 'No. It prepares the worksheets; you file.',
              question: 'Does it file taxes?'
            },
            { answer: 'Most US banks.', question: 'Which banks can I connect?' }
          ]
        }
      })
    )
    expect(html).toContain('id="faqs"')
    expect(html).toContain('>FAQs<')
    expect(html).toContain('Does it file taxes?')
    expect(html).toContain('Which banks can I connect?')
    expect(html).toContain('No. It prepares the worksheets; you file.')
    // Closed: each answer's panel is in the HTML with the `hidden` attribute, not left out.
    expect(
      html.match(/data-closed="" [^>]*hidden=""[^>]*data-slot="accordion-content"/gu)
    ).toHaveLength(2)
  })

  it('leaves out only FAQs whose exact heading line the description still holds (#105)', () => {
    const faqs = [
      { answer: 'From the import.', question: 'How do I download a video?' },
      { answer: 'Added by the owner.', question: 'Is it free?' }
    ]
    const content =
      '## Pricing\n\nIs it free? Yes, for personal use.\n\n## FAQ\n\n### How do I download a video?\n\nPaste the link.'
    // The import's heading hides its copy; the same question in prose never hides an FAQ.
    expect(faqsToShow(faqs, content)).toEqual([faqs[1]])
    expect(faqsToShow(faqs, '#### How do I download a video?')).toEqual(faqs)
    // A heading in the body, outside the closing FAQ block, never hides an FAQ.
    expect(faqsToShow(faqs, 'Intro\n\n### Is it free?\n\nYes.')).toEqual(faqs)
    expect(
      faqsToShow(faqs, '### Is it free?\n\nYes.\n\n## FAQ\n\n### How do I download a video?')
    ).toEqual([faqs[1]])
    expect(faqsToShow(faqs, '### How do I download a video? (2026)')).toEqual(faqs)
    expect(faqsToShow(faqs, undefined)).toEqual(faqs)
    expect(faqsToShow(undefined, content)).toEqual([])
  })
})

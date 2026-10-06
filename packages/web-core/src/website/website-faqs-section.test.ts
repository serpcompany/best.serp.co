import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { WebsiteFaqsSection } from './website-faqs-section'

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
    // Closed, and hidden by the item's CSS rather than left out.
    expect(html).toContain('data-slot="accordion-content"')
    expect(html).toContain('[&amp;_[data-slot=accordion-content][data-state=closed]]:hidden')
  })
})

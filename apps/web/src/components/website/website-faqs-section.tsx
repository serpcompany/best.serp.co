import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger
} from '@/components/ui/accordion'
import type { WebsiteFaq } from '../../lib/directory/content-query'
import { Section } from '../layout/section'

export interface WebsiteFaqsSectionProps {
  website: { faqs?: WebsiteFaq[] }
}

/**
 * The FAQs the section shows: all of them, except an FAQ whose exact heading line
 * (`### <question>`) the long description still holds after its last `## FAQ` line. That is the one-time import's copy of the
 * FAQs (335 listings, every FAQ under such a heading), which the #105 manifest
 * (`d1/publications/2026-10-06-listing-faqs.yaml`) removes from the descriptions. Until it is
 * published on an environment, this keeps those FAQs from showing twice. It matches whole
 * heading lines in that closing block only, never prose or other headings, and does nothing once
 * the manifest is published.
 */
export function faqsToShow(faqs: readonly WebsiteFaq[] | undefined, content: string | undefined) {
  // Only the import's block counts: the headings after the description's last `## FAQ` line.
  const lines = (content ?? '').split('\n')
  const start = lines.lastIndexOf('## FAQ')
  const headings = new Set(
    start < 0 ? [] : lines.slice(start + 1).filter(line => line.startsWith('### '))
  )
  // The import escaped MDX braces in its headings (`\{`), so both spellings count.
  const escaped = (text: string) => text.replaceAll('{', '\\{').replaceAll('}', '\\}')
  return (faqs ?? []).filter(
    faq => !headings.has(`### ${faq.question}`) && !headings.has(`### ${escaped(faq.question)}`)
  )
}

/**
 * The listing's FAQs (#105): the owner-approved questions and answers from D1, in a stock shadcn
 * Accordion inside the same card as the Links section. Nothing renders when there are none.
 * Answers stay in the HTML while closed (`forceMount`, hidden by CSS until opened), so the page
 * reads the same to visitors and crawlers.
 */
export function WebsiteFaqsSection({ website }: WebsiteFaqsSectionProps) {
  const faqs = website.faqs ?? []
  if (faqs.length === 0) return null
  return (
    <section className="animate-fade-in-up opacity-0 stagger-3">
      <Section title="FAQs" titleId="faqs">
        <div className="rounded-2xl border bg-card/50 backdrop-blur-sm overflow-hidden">
          <Accordion type="multiple">
            {faqs.map((faq, index) => (
              <AccordionItem
                key={faq.question}
                value={`faq-${index}`}
                // `forceMount` keeps a closed answer rendered, so it's hidden here instead.
                className="[&_[data-slot=accordion-content][data-state=closed]]:hidden"
              >
                <AccordionTrigger className="px-6 text-base">{faq.question}</AccordionTrigger>
                <AccordionContent
                  forceMount
                  className="px-6 whitespace-pre-line text-muted-foreground"
                >
                  {faq.answer}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>
      </Section>
    </section>
  )
}

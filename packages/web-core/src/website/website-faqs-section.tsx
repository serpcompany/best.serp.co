import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger
} from '@serpdirectory/design-system/accordion'
import type { WebsiteFaq } from '../content-query'
import { Section } from '../layout/section'

export interface WebsiteFaqsSectionProps {
  website: { faqs?: WebsiteFaq[] }
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
                key={`${index}-${faq.question}`}
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

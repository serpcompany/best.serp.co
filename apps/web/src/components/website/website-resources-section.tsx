import { ExternalLink } from 'lucide-react'
import Link from 'next/link'
import type { ComponentType, ReactNode } from 'react'
import { Item, ItemActions, ItemContent, ItemTitle } from '@/components/ui/item'
import { withDubVia } from '../../lib/analytics/dub-via'
import { getListingSpecificResourceLinks } from '../../lib/directory/resource-links'
import type { WebsiteResourceLink } from '../../lib/seo/website-schema'

type SectionProps = {
  children: ReactNode
  description?: string
  title: string
  titleId?: string
}

type WebsiteCliSectionProps = {
  website: {
    slug: string
  }
}

type WebsiteResourcesWebsite = {
  slug: string
  resourceLinks?: WebsiteResourceLink[]
}

export interface WebsiteResourcesSectionProps {
  website: WebsiteResourcesWebsite
  slots: {
    Section: ComponentType<SectionProps>
    WebsiteCliSection: ComponentType<WebsiteCliSectionProps>
  }
}

export function WebsiteResourcesSection({
  website,
  slots: { Section, WebsiteCliSection }
}: WebsiteResourcesSectionProps) {
  const resourceLinks = getListingSpecificResourceLinks(website.resourceLinks)

  return (
    <>
      <WebsiteCliSection website={{ slug: website.slug }} />

      {resourceLinks.length > 0 ? (
        <Section title="Links" titleId="links">
          {/* Outline items, as serplists' ListCard (#273), each an outbound link. */}
          <ul className="flex flex-col gap-2">
            {resourceLinks.map(link => (
              <li key={`${link.label}-${link.url}`}>
                <Item
                  variant="outline"
                  render={
                    <Link href={withDubVia(link.url)} target="_blank" rel="noopener noreferrer" />
                  }
                >
                  <ItemContent className="min-w-0">
                    <ItemTitle className="w-full">
                      <span className="min-w-0 truncate">{link.label}</span>
                    </ItemTitle>
                  </ItemContent>
                  <ItemActions>
                    <ExternalLink className="size-4 text-muted-foreground" aria-hidden />
                  </ItemActions>
                </Item>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </>
  )
}

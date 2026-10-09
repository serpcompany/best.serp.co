import { ExternalLink } from 'lucide-react'
import Link from 'next/link'
import { Item, ItemActions, ItemContent, ItemTitle } from '@/components/ui/item'
import { withDubVia } from '../../lib/analytics/dub-via'
import { getListingSpecificResourceLinks } from '../../lib/directory/resource-links'
import type { WebsiteResourceLink } from '../../lib/seo/website-schema'
import { Section } from '../layout/section'

type WebsiteResourcesWebsite = {
  resourceLinks?: WebsiteResourceLink[]
}

export interface WebsiteResourcesSectionProps {
  website: WebsiteResourcesWebsite
}

export function WebsiteResourcesSection({ website }: WebsiteResourcesSectionProps) {
  const resourceLinks = getListingSpecificResourceLinks(website.resourceLinks)

  if (resourceLinks.length === 0) return null

  return (
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
  )
}

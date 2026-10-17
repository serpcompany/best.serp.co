import Link from 'next/link'
import type { WebsiteRelatedCardMetadata } from '../../lib/directory/content-query'
import { getRoute } from '../../lib/routing/routes'
import { ListingImage } from '../listing/listing-image'
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card'
import { Item, ItemContent, ItemMedia, ItemTitle } from '../ui/item'

export type WebsiteAlternativesProps = {
  websites: WebsiteRelatedCardMetadata[]
}

/**
 * A listing page's Alternatives (#519, #535): its hand picks first, then similar listings, at most
 * six, as a compact list of logos and names under Visit Site, in the desktop column that sticks,
 * and after the article on phones. A region named by its heading; nothing without an alternative.
 */
export function WebsiteAlternatives({ websites }: WebsiteAlternativesProps) {
  if (websites.length === 0) {
    return null
  }

  return (
    <section aria-labelledby="alternatives">
      <Card>
        <CardHeader>
          <CardTitle>
            <h2 id="alternatives">Alternatives</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="px-2">
          <ul className="flex flex-col">
            {websites.map(website => (
              <li key={website.slug}>
                <Item
                  size="xs"
                  render={
                    <Link
                      href={getRoute('listing.detail', { slug: website.slug })}
                      data-website-slug={website.slug}
                    />
                  }
                >
                  {/* The name names the link; the logo is decoration here. */}
                  <ItemMedia aria-hidden="true">
                    <ListingImage
                      name={website.name}
                      src={website.media?.logo}
                      size={24}
                      className="rounded-md"
                    />
                  </ItemMedia>
                  <ItemContent className="min-w-0">
                    <ItemTitle className="block w-full truncate">{website.name}</ItemTitle>
                  </ItemContent>
                </Item>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </section>
  )
}

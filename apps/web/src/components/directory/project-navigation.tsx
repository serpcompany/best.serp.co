import { getRoute } from '../../lib/routing/routes'
import { CardGrid } from '../layout/card-grid'
import { ListCard } from '../layout/list-card'
import { ListingImage } from '../listing/listing-image'

interface ProjectNavItem {
  media?: {
    logo?: string
  }
  slug: string
  name: string
  website: string
}

interface ProjectNavigationProps {
  previousWebsite: ProjectNavItem | null
  nextWebsite: ProjectNavItem | null
}

function NavigationCard({ label, website }: { label: string; website: ProjectNavItem }) {
  return (
    <ListCard
      href={getRoute('listing.detail', { slug: website.slug })}
      icon={
        <ListingImage
          name={website.name}
          src={website.media?.logo}
          size={32}
          className="rounded-lg"
        />
      }
      title={website.name}
      description={label}
    />
  )
}

/**
 * The previous and next listings (#273): two `ListCard`s side by side, the next one on the right
 * even when there is no previous one.
 */
export function ProjectNavigation({ previousWebsite, nextWebsite }: ProjectNavigationProps) {
  return (
    <CardGrid as="ul" columns={2}>
      {previousWebsite ? (
        <li className="min-w-0">
          <NavigationCard label="Previous" website={previousWebsite} />
        </li>
      ) : (
        <li className="max-sm:hidden" aria-hidden="true" />
      )}
      {nextWebsite ? (
        <li className="min-w-0">
          <NavigationCard label="Next" website={nextWebsite} />
        </li>
      ) : null}
    </CardGrid>
  )
}

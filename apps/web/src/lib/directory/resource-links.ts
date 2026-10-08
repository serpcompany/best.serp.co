export type ResourceLink = {
  label: string
  url: string
}

export function isGenericGithubOrganizationLink(link: ResourceLink): boolean {
  try {
    const url = new URL(link.url)
    const pathSegments = url.pathname.split('/').filter(Boolean)

    return url.hostname.toLowerCase() === 'github.com' && pathSegments.length <= 1
  } catch (_error) {
    return false
  }
}

export function isForbiddenListingResourceLink(link: ResourceLink): boolean {
  return /\bhttps?:\/\/help\.serp\.co\/en(?:\/|(?=$)|[?#])/i.test(link.url)
}

export function getListingSpecificResourceLinks<Link extends ResourceLink>(
  resourceLinks: Link[] | undefined
): Link[] {
  return (
    resourceLinks?.filter(
      link => !isGenericGithubOrganizationLink(link) && !isForbiddenListingResourceLink(link)
    ) ?? []
  )
}

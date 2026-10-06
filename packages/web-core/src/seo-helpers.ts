import { SITE_NAME } from './seo-config';
import { siteCopy } from './site-copy';

export function generateAltText(
  type: 'favicon' | 'avatar' | 'logo' | 'website',
  name: string
): string {
  switch (type) {
    case 'favicon':
      return `${name} favicon`;
    case 'avatar':
      return `${name} profile picture`;
    case 'logo':
      return `${SITE_NAME} logo`;
    case 'website':
      return `${name} ${siteCopy.listingName.singular}`;
    default:
      return name;
  }
}

export function formatPageTitle(title: string, includeSiteName = true): string {
  const cleanTitle = title.trim();
  if (!includeSiteName || cleanTitle.includes(SITE_NAME)) {
    return cleanTitle;
  }
  return `${cleanTitle} | ${SITE_NAME}`;
}

export function optimizeMetaDescription(description: string, maxLength = 160): string {
  if (description.length <= maxLength) {
    return description;
  }

  const truncated = description.substring(0, maxLength - 3);
  const lastSpace = truncated.lastIndexOf(' ');
  return `${truncated.substring(0, lastSpace)}...`;
}

import type { Metadata } from 'next';
import { getRoute } from './routes';
import { siteCopy } from './site-copy';
import { siteContent } from './site-content';
import {
  getConfiguredSocialLinks,
  getTwitterHandleFromUrl,
  hasConfiguredPublicSocialLinks,
  siteConfig,
} from './site-config';

export const SITE_NAME = siteConfig.name;
export const SITE_TAGLINE = siteConfig.tagline;
export const SITE_DESCRIPTION = siteConfig.description;
export const SITE_PUBLIC_URL = siteConfig.publicUrl;
export const SITE_URL = SITE_PUBLIC_URL;
export const SITE_TWITTER_HANDLE = hasConfiguredPublicSocialLinks(siteConfig)
  ? getTwitterHandleFromUrl(siteConfig.twitterUrl)
  : null;
export const SITE_FAVICON_URL =
  siteConfig.branding.faviconUrl ?? `${SITE_URL}/favicon.ico`;
export const SITE_APPLE_TOUCH_ICON_URL =
  siteConfig.branding.appleTouchIconUrl ?? `${SITE_URL}/apple-touch-icon.png`;
function absoluteSiteAssetUrl(url: string): string {
  return new URL(url, SITE_URL).toString();
}

export const SITE_LOGO_URL = absoluteSiteAssetUrl(
  siteConfig.branding.logoUrl ?? `${SITE_URL}/placeholder.svg`
);
export const SITE_OG_IMAGE_URL = absoluteSiteAssetUrl(
  siteConfig.branding.opengraphImageUrl ?? SITE_LOGO_URL
);
export const DIRECTORY_LISTINGS_KEYWORD = `directory ${siteCopy.listingName.plural}`;

export const DEFAULT_OG_IMAGE = {
  url: SITE_OG_IMAGE_URL,
  width: 1200,
  height: 630,
  alt: `${SITE_NAME} - ${SITE_TAGLINE}`,
};

export const ROBOTS_CONFIG = {
  index: true,
  follow: true,
  googleBot: {
    index: true,
    follow: true,
    noimageindex: false,
    'max-video-preview': -1,
    'max-image-preview': 'large' as const,
    'max-snippet': -1,
  },
};

export const KEYWORDS = {
  global: [DIRECTORY_LISTINGS_KEYWORD, 'listing directory', 'resources', 'documentation', 'discover'],
  homepage: [SITE_NAME, DIRECTORY_LISTINGS_KEYWORD, 'listing directory', 'resources'],
  categories: {
    ai: ['AI tools', 'artificial intelligence', 'machine learning', 'neural networks'],
    'developer-tools': ['developer tools', 'programming', 'software development', 'coding tools'],
    education: ['education technology', 'e-learning', 'online courses', 'educational platforms'],
    productivity: ['productivity tools', 'workflow automation', 'task management', 'efficiency'],
    documentation: ['technical documentation', 'API docs', 'developer docs', 'knowledge base'],
    saas: ['SaaS platforms', 'cloud software', 'web applications', 'software as a service'],
  },
};

export function generateBaseMetadata(options: {
  title: string;
  description: string;
  path?: string;
  keywords?: string[];
  image?: typeof DEFAULT_OG_IMAGE;
  noindex?: boolean;
}): Metadata {
  const {
    title,
    description,
    path = '',
    keywords = KEYWORDS.global,
    image = DEFAULT_OG_IMAGE,
    noindex = false,
  } = options;

  const url = `${SITE_URL}${path}`;

  return {
    title,
    description,
    keywords: keywords.join(', '),
    authors: [{ name: SITE_NAME, url: SITE_URL }],
    creator: SITE_NAME,
    publisher: SITE_NAME,
    metadataBase: new URL(SITE_URL),
    alternates: {
      canonical: url,
    },
    openGraph: {
      title,
      description,
      url,
      siteName: SITE_NAME,
      images: [image],
      locale: 'en_US',
      type: 'website',
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      site: SITE_TWITTER_HANDLE || undefined,
      creator: SITE_TWITTER_HANDLE || undefined,
      images: [image.url],
    },
    robots: noindex
      ? {
          index: false,
          follow: false,
          googleBot: {
            index: false,
            follow: false,
          },
        }
      : ROBOTS_CONFIG,
    verification: {
      google: process.env.NEXT_PUBLIC_GOOGLE_VERIFICATION,
      yandex: process.env.NEXT_PUBLIC_YANDEX_VERIFICATION,
      other: {
        'msvalidate.01': process.env.NEXT_PUBLIC_BING_VERIFICATION || '',
      },
    },
  };
}

export function generateDynamicMetadata(options: {
  type: 'website' | 'listing' | 'category' | 'member' | 'guide' | 'news' | 'doc';
  name: string;
  description: string;
  slug: string;
  additionalKeywords?: string[];
  image?: typeof DEFAULT_OG_IMAGE;
  publishedAt?: string;
  updatedAt?: string;
}): Metadata {
  const {
    type,
    name,
    description,
    slug,
    additionalKeywords = [],
    image,
    publishedAt,
    updatedAt,
  } = options;

  let path = '';
  let title = name;

  switch (type) {
    case 'website':
    case 'listing':
      path = getRoute('listing.detail', { slug });
      title = `${name} - ${siteCopy.listingName.singularTitle}`;
      break;
    case 'category':
      path = getRoute('category.page', { category: slug });
      title = name;
      break;
    case 'member':
      path = `/u/${slug}`;
      title = `${name} - Community Member`;
      break;
    case 'guide':
      path = getRoute('guides.guide', { slug });
      title = `${name} - Developer Guide`;
      break;
    case 'news':
      path = `/news/${slug}`;
      title = `${name} - News & Updates`;
      break;
    case 'doc':
      path = getRoute('docs.doc', { slug });
      title = `${name} - ${siteCopy.docsLabel}`;
      break;
  }

  const metadata = generateBaseMetadata({
    title,
    description,
    path,
    keywords: [...KEYWORDS.global, ...additionalKeywords],
    image,
  });

  if (
    (type === 'guide' || type === 'news' || type === 'website' || type === 'listing') &&
    publishedAt
  ) {
    metadata.openGraph = {
      ...metadata.openGraph,
      type: 'article',
      publishedTime: publishedAt,
      modifiedTime: updatedAt || publishedAt,
      authors: [SITE_NAME],
      section:
        type === 'website' || type === 'listing'
          ? siteCopy.listingName.singularTitle
          : undefined,
    };
  }

  return metadata;
}

export function generateBreadcrumbSchema(items: Array<{ name: string; url?: string }>) {
  const breadcrumbs = items.map((item, index) => ({
    '@type': 'ListItem',
    position: index + 1,
    name: item.name,
    ...(item.url ? { item: `${SITE_URL}${item.url}` } : {}),
  }));

  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: breadcrumbs,
  };
}

export function generateWebsiteSchema() {
  const sameAs = [
    ...getConfiguredSocialLinks(siteConfig),
    ...siteContent.networkLinks.map(link => link.href),
  ];

  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: SITE_NAME,
    description: SITE_DESCRIPTION,
    url: SITE_PUBLIC_URL,
    potentialAction: {
      '@type': 'SearchAction',
      target: {
        '@type': 'EntryPoint',
        urlTemplate: `${SITE_PUBLIC_URL}/search/?q={search_term_string}`,
      },
      'query-input': 'required name=search_term_string',
    },
    publisher: {
      '@type': 'Organization',
      name: SITE_NAME,
      url: SITE_PUBLIC_URL,
      logo: {
        '@type': 'ImageObject',
        url: SITE_LOGO_URL,
      },
      sameAs: [...new Set(sameAs)],
    },
  };
}

export function generateCollectionSchema(options: {
  name: string;
  description: string;
  url: string;
  itemCount: number;
}) {
  return {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: options.name,
    description: options.description,
    url: `${SITE_URL}${options.url}`,
    numberOfItems: options.itemCount,
    isPartOf: {
      '@type': 'WebSite',
      name: SITE_NAME,
      url: SITE_URL,
    },
  };
}

export { formatPageTitle, generateAltText, optimizeMetaDescription } from './seo-helpers';

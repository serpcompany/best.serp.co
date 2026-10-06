import type { Metadata } from 'next';
import { generateBaseMetadata } from './seo-config';
import { siteConfig, type SiteConfig } from './site-config';

export type RoutableSiteFeature = keyof Pick<
  SiteConfig['features'],
  | 'showAuth'
  | 'showBrands'
  | 'showDocs'
  | 'showFavorites'
  | 'showGuides'
  | 'showProjects'
>;

export function isRouteFeatureEnabled(feature: RoutableSiteFeature): boolean {
  return Boolean(siteConfig.features[feature]);
}

export function generateDisabledRouteMetadata(): Metadata {
  return generateBaseMetadata({
    title: 'Page Not Found',
    description: 'The page you are looking for does not exist.',
    noindex: true,
  });
}

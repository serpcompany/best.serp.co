import { ExternalLink, Home as HomeIcon } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { ComponentType } from 'react';
import { Suspense } from 'react';
import {
  getActiveCategories,
  type CategoryLike,
} from '../category-navigation';
import { getCategoryDisplayName } from '../category-display';
import { externalResources } from '../external-resources';
import { getRoute } from '../routes';
import { generateBaseMetadata } from '../seo-config';
import { siteCopy } from '../site-copy';
import { siteConfig } from '../site-config';
import type { WebsiteMetadata } from '../content-query';

type SearchResultsSlot = ComponentType;

type SearchIndexPageProps = {
  allProjects: Array<WebsiteMetadata & CategoryLike>;
  slots: {
    SearchResults: SearchResultsSlot;
  };
};

function showExternalSearchResources(): boolean {
  return (
    siteConfig.features.showExternalResources && externalResources.length > 0
  );
}

export function generateSearchPageMetadata(): Metadata {
  const showExternalResources = showExternalSearchResources();

  return generateBaseMetadata({
    title: 'Search',
    description: showExternalResources
      ? `Search for listings and external resources in ${siteConfig.name}.`
      : `Search for listings and resources in ${siteConfig.name}.`,
    path: '/search',
    keywords: showExternalResources
      ? [
          'search',
          'find',
          'directory listings',
          'external resources',
          'resources',
        ]
      : ['search', 'find', 'directory listings', 'resources'],
    noindex: true,
  });
}

export function SearchIndexPage({
  allProjects,
  slots,
}: SearchIndexPageProps) {
  const showExternalResources = showExternalSearchResources();
  const activeCategories = getActiveCategories(allProjects);
  const { SearchResults } = slots;

  return (
    <div className="border-t">
      <div className="relative flex h-full w-full max-w-full flex-row flex-nowrap">
        <div className="sticky top-16 hidden h-screen w-[240px] max-w-[240px] min-w-[240px] overflow-hidden border-r sm:block">
          <div className="space-y-6 p-4">
            <h2 className="sr-only">Search Filters</h2>

            <div>
              <h3 className="mb-4 text-sm font-semibold text-muted-foreground">
                Categories
              </h3>
              <nav className="space-y-1">
                <Link
                  href={getRoute('home')}
                  className="flex items-center gap-2 rounded-md px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                >
                  <HomeIcon className="h-4 w-4" />
                  {siteCopy.allLabel}
                </Link>
                {activeCategories.map((category) => (
                  <Link
                    key={category.slug}
                    href={getRoute('category.page', {
                      category: category.slug,
                    })}
                    className="flex items-center gap-2 rounded-md px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                  >
                    <category.icon className="h-4 w-4" />
                    {getCategoryDisplayName(category.slug)}
                  </Link>
                ))}
              </nav>
            </div>

            {showExternalResources ? (
              <div>
                <h3 className="mb-4 text-sm font-semibold text-muted-foreground">
                  Resources
                </h3>
                <nav className="space-y-1">
                  {externalResources.map((resource) => (
                    <Link
                      key={resource.slug}
                      href={resource.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="group flex items-center justify-between gap-2 rounded-md px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <resource.icon className="h-4 w-4 flex-shrink-0" />
                        <span className="truncate">{resource.name}</span>
                      </div>
                      <ExternalLink className="h-3 w-3 flex-shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
                    </Link>
                  ))}
                </nav>
              </div>
            ) : null}
          </div>
        </div>

        <div className="relative flex h-full w-full flex-col gap-3 px-6 pt-6">
          <section className="space-y-6">
            <div className="sticky top-16 z-35 -mx-6 border-b bg-background px-6 py-4">
              <h1 className="text-2xl font-bold">Search</h1>
              <p className="mt-1 text-muted-foreground">
                {showExternalResources
                  ? `Searching across all ${siteCopy.listingName.plural} and resources`
                  : `Searching across all ${siteCopy.listingName.plural}`}
              </p>
            </div>

            <Suspense
              fallback={
                <div className="flex justify-center py-8">
                  <div className="h-12 w-12 animate-spin rounded-full border-b-2 border-t-2 border-primary-500" />
                </div>
              }
            >
              <SearchResults />
            </Suspense>
          </section>
        </div>
      </div>
    </div>
  );
}

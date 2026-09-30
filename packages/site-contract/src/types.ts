export type AssetSource =
  | {
      path: string
      source: 'local-path'
    }
  | {
      source: 'url'
      url: string
    }

export type ListingSourceConfig = {
  approvedOnly: true
  binding: 'DB'
  kind: 'd1-listings'
  siteId: 'pornvideodownloaders.com' | 'serp.software'
}

export type SiteCopyConfig = {
  brandsLabel: string
  categoryLabels: Record<string, string>
  docsLabel: string
  listingName: {
    plural: string
    singular: string
  }
  networkLabel: string
  submitLabel: string
}

export type SiteExternalResourceIcon = 'chrome' | 'code2' | 'command' | 'gitBranch' | 'terminal'

export type SiteExternalResource = {
  description: string
  href: string
  icon: SiteExternalResourceIcon
  imageAlt?: string
  imageSrc?: string
  name: string
  slug: string
}

export type SiteListingCliInstall = {
  commandPrefix: string
  installTargetByListingSlug: Record<string, string>
}

export type SiteNetworkLink = {
  description: string
  href: string
  label: string
  title: string
}

export type SiteOwnedContent = {
  externalResources: SiteExternalResource[]
  listingCliInstall: SiteListingCliInstall | null
  networkLinks: SiteNetworkLink[]
}

export type SiteAnalyticsConfig = {
  gtmId?: string
}

export type SiteBadgesConfig = {
  featuredOn?: {
    dark?: string
    displayName?: string
    light?: string
  }
}

export type OpenNextCloudflareWorkerDeployConfig = {
  previewConfigPath: string
  productionConfigPath: string
  strategy: 'opennext-cloudflare-worker'
}

export type DeployConfig = OpenNextCloudflareWorkerDeployConfig

export type SiteFeatureFlags = {
  showAuth: boolean
  showBrands: boolean
  showCreatorProjects: boolean
  showDocs: boolean
  showExternalResources: boolean
  showFavorites: boolean
  showFeaturedGuides: boolean
  showGuides: boolean
  showNewsletter: boolean
  showProjects: boolean
}

export type SiteSitemapGroupKey = 'docs' | 'listings' | 'pages' | 'posts' | 'taxonomies'

export type SiteSitemapConfig = {
  additionalPathsByGroup?: Partial<Record<SiteSitemapGroupKey, string[]>>
  artifactExcludedPaths?: string[]
  categoryBasePath?: string
  excludedPaths?: string[]
  featuredCategoryPath?: string
  indexGroupOrder?: SiteSitemapGroupKey[]
  listingDetailSuffix?: string
  pathByGroup?: Partial<Record<SiteSitemapGroupKey, string>>
  staticPagePaths?: string[]
}

export type CheckedInSiteConfig = {
  analytics?: SiteAnalyticsConfig
  badges?: SiteBadgesConfig
  branding: {
    favicon?: AssetSource
    logo?: AssetSource
    opengraphImage?: AssetSource
  }
  build: {
    appPackageName: string
    appOutDir: string
    artifactDir: string
    mode: 'opennext-cloudflare-worker'
  }
  copy: SiteCopyConfig
  content: {
    listingSource: ListingSourceConfig
  }
  deploy?: DeployConfig
  features: SiteFeatureFlags
  id: string
  networkBrandGroup: string | null
  routes: {
    brandsBasePath: string
    docsBasePath: string
    listingBasePath: string
    networkBasePath: string
  }
  site: {
    description: string
    domain: string
    name: string
    publicUrl: string
    tagline: string
  }
  sitemap: SiteSitemapConfig
  social: {
    githubIssueOwner: string | null
    githubIssueRepo: string | null
    githubIssuesUrl: string | null
    githubRepoUrl: string
    githubUrl: string
    redditUrl: string
    twitterUrl: string
  }
  version: 1
}

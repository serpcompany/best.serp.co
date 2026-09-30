import type { CheckedInSiteConfig } from '../types'

export const serpSoftwareSiteConfig: CheckedInSiteConfig = {
  analytics: {
    gtmId: 'GTM-W59GNHXF'
  },
  badges: {
    featuredOn: {
      dark: 'badge/featured-on-serp.software-dark.svg',
      light: 'badge/featured-on-serp.software-light.svg'
    }
  },
  branding: {},
  build: {
    appPackageName: 'serp.software',
    appOutDir: 'apps/serp.software/.open-next',
    artifactDir: 'apps/serp.software/.open-next',
    mode: 'opennext-cloudflare-worker'
  },
  content: {
    listingSource: {
      approvedOnly: true,
      binding: 'DB',
      kind: 'd1-listings',
      siteId: 'serp.software'
    }
  },
  copy: {
    brandsLabel: 'Brands',
    categoryLabels: {},
    docsLabel: 'Docs',
    listingName: {
      plural: 'products',
      singular: 'product'
    },
    networkLabel: 'Network',
    submitLabel: 'Submit Yours'
  },
  deploy: {
    previewConfigPath: 'configs/wrangler/serp.software/preview.jsonc',
    productionConfigPath: 'configs/wrangler/serp.software/production.jsonc',
    strategy: 'opennext-cloudflare-worker'
  },
  features: {
    showAuth: false,
    showBrands: true,
    showCreatorProjects: false,
    showDocs: false,
    showExternalResources: false,
    showFavorites: false,
    showFeaturedGuides: false,
    showGuides: false,
    showNewsletter: true,
    showProjects: false
  },
  id: 'serp.software',
  networkBrandGroup: 'all',
  routes: {
    brandsBasePath: 'brands',
    docsBasePath: 'docs',
    listingBasePath: 'products',
    networkBasePath: 'network'
  },
  sitemap: {
    excludedPaths: ['/products']
  },
  site: {
    description: 'A searchable directory of downloader products from the SERP network.',
    domain: 'serp.software',
    name: 'SERP Software',
    publicUrl: 'https://serp.software',
    tagline: 'Downloader software in one searchable directory.'
  },
  social: {
    githubIssueOwner: null,
    githubIssueRepo: null,
    githubIssuesUrl: null,
    githubRepoUrl: 'https://github.com/serpcompany',
    githubUrl: 'https://github.com/serpcompany',
    redditUrl: 'https://www.reddit.com/r/serpapps/',
    twitterUrl: 'https://x.com/serpapps'
  },
  version: 1
}

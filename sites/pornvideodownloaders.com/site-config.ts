import type { CheckedInSiteConfig } from '../types'

export const pornVideoDownloadersComSiteConfig: CheckedInSiteConfig = {
  analytics: {
    gtmId: 'GTM-PWB7MRW9'
  },
  badges: {
    featuredOn: {
      dark: 'badge/featured-on-pornvideodownloaders.com-dark.svg',
      displayName: 'PV Downloaders',
      light: 'badge/featured-on-pornvideodownloaders.com-light.svg'
    }
  },
  branding: {
    favicon: {
      path: 'sites/pornvideodownloaders.com/assets/favicon.ico',
      source: 'local-path'
    },
    logo: {
      path: 'sites/pornvideodownloaders.com/assets/logo.png',
      source: 'local-path'
    },
    opengraphImage: {
      path: 'sites/pornvideodownloaders.com/assets/opengraph-image.png',
      source: 'local-path'
    }
  },
  build: {
    appPackageName: 'pornvideodownloaders.com',
    appOutDir: 'apps/pornvideodownloaders.com/.open-next',
    artifactDir: 'apps/pornvideodownloaders.com/.open-next',
    mode: 'opennext-cloudflare-worker'
  },
  content: {
    listingSource: {
      approvedOnly: true,
      binding: 'DB',
      kind: 'd1-listings',
      siteId: 'pornvideodownloaders.com'
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
    previewConfigPath: 'configs/wrangler/pornvideodownloaders.com/preview.jsonc',
    productionConfigPath: 'configs/wrangler/pornvideodownloaders.com/production.jsonc',
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
  id: 'pornvideodownloaders.com',
  networkBrandGroup: 'adultsOnly',
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
    description: 'Downloaders for adult video platforms and creator sites.',
    domain: 'pornvideodownloaders.com',
    name: 'Porn Video Downloaders',
    publicUrl: 'https://pornvideodownloaders.com',
    tagline: 'Adult video downloader tools in one searchable directory.'
  },
  social: {
    githubIssueOwner: null,
    githubIssueRepo: null,
    githubIssuesUrl: null,
    githubRepoUrl: 'https://github.com/serpxxx',
    githubUrl: 'https://github.com/serpxxx',
    redditUrl: 'https://www.reddit.com/r/serpxxx/',
    twitterUrl: 'https://x.com/serpapps'
  },
  version: 1
}

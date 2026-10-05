import type { SiteDefinition } from './types'

export const site: SiteDefinition = {
  analytics: {
    gtmId: 'GTM-W59GNHXF'
  },
  badges: {
    featuredOn: {
      dark: 'badge/featured-on-serp.co-dark.svg',
      light: 'badge/featured-on-serp.co-light.svg'
    }
  },
  branding: {
    favicon: { path: 'apps/web/public/favicon.ico', source: 'local-path' },
    logo: { path: 'apps/web/public/logo.png', source: 'local-path' },
    opengraphImage: { path: 'apps/web/public/opengraph-image.png', source: 'local-path' }
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
    submitLabel: 'Submit'
  },
  // mail.serp.co is a dedicated sending subdomain, so this mail's reputation stays separate
  // from serp.co (serpcompany/best.serp.co#59).
  email: {
    from: { address: 'noreply@mail.serp.co', name: 'SERP Directory' },
    supportAddress: 'support@serp.co'
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
  id: 'best.serp.co',
  networkBrandGroup: 'all',
  routes: {
    brandsBasePath: 'brands',
    docsBasePath: 'docs',
    listingBasePath: 'products',
    networkBasePath: 'network'
  },
  sitemap: {
    categoryBasePath: 'products/categories',
    excludedPaths: [
      '/legal/affiliate-disclosure',
      '/legal/dmca',
      '/legal/privacy-policy',
      '/legal/terms-conditions',
      '/products/categories/other',
      '/submit'
    ],
    pathByGroup: {
      listings: '/sitemaps/directory/1.xml',
      pages: '/sitemaps/pages/1.xml',
      taxonomies: '/sitemaps/categories/1.xml'
    },
    staticPagePaths: [
      '/',
      '/about',
      '/brands',
      '/contact',
      '/legal',
      '/legal/affiliate-disclosure',
      '/legal/dmca',
      '/legal/privacy-policy',
      '/legal/terms-conditions',
      '/pricing',
      '/products/categories',
      '/sponsor',
      '/submit'
    ]
  },
  site: {
    description:
      'SERP helps people discover software, AI tools, companies, resources, and projects from the SERP network.',
    domain: 'best.serp.co',
    // The legal pages have always named dmca@ and privacy@ at serp.co. best.serp.co has no
    // mail routing yet (its DNS is a GitHub Pages CNAME until cutover); switch this to
    // best.serp.co once Email Routing forwards dmca@best.serp.co (serpcompany/best.serp.co#42).
    legalEmailDomain: 'serp.co',
    name: 'SERP',
    publicUrl: 'https://best.serp.co',
    tagline: 'Software, AI tools, companies, resources, and SERP projects'
  },
  social: {
    githubIssueOwner: null,
    githubIssueRepo: null,
    githubIssuesUrl: null,
    githubRepoUrl: 'https://github.com/serpcompany',
    githubUrl: 'https://github.com/serpcompany',
    redditUrl: 'https://www.reddit.com/r/serpapps/',
    twitterUrl: 'https://x.com/serpdotco'
  },
  version: 1
}

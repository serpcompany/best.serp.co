export type AssetSource =
  | {
      path: string
      source: 'local-path'
    }
  | {
      source: 'url'
      url: string
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
  /** The site's Dub partner ID: `?via=` on every `serp.ly` link it renders (#169). */
  dubPartnerId?: string
  gtmId?: string
}

export type SiteBadgesConfig = {
  featuredOn?: {
    dark?: string
    displayName?: string
    light?: string
  }
}

export type SiteFeatureFlags = {
  showAuth: boolean
  showBrands: boolean
  showDocs: boolean
  showExternalResources: boolean
  showFavorites: boolean
  showFeaturedGuides: boolean
  showGuides: boolean
  showNewsletter: boolean
  showProjects: boolean
}

/**
 * How catalog URLs are shaped. Which pages exist, are indexable, and are in which sitemap is the
 * route registry's (`./site-routes.ts`).
 */
export type SiteSitemapConfig = {
  categoryBasePath?: string
  listingDetailSuffix?: string
}

export type SiteDefinition = {
  analytics?: SiteAnalyticsConfig
  badges?: SiteBadgesConfig
  branding: {
    favicon?: AssetSource
    logo?: AssetSource
    opengraphImage?: AssetSource
  }
  copy: SiteCopyConfig
  /** Transactional email identity (`apps/web/src/lib/email/`). */
  email: {
    /** Root-relative path of the admin dashboard that admin email footers link to. */
    adminDashboardPath: string
    /** Who receives admin alerts (submission ready for review, new message). */
    adminRecipient: string
    /**
     * Root-relative path of the dashboard every user email footer links to. The sender is not
     * monitored, so replies happen there (serpcompany/best.serp.co#73).
     */
    dashboardPath: string
    /**
     * The sender in every environment (staging and production send from the same domain
     * verified in useSend; local logs show it). Sent with no Reply-To.
     */
    from: { address: string; name: string }
  }
  features: SiteFeatureFlags
  id: string
  routes: {
    brandsBasePath: string
    docsBasePath: string
    listingBasePath: string
    networkBasePath: string
  }
  /** The submit flow (serpcompany/best.serp.co#59). */
  submissions: {
    /** The paid listing's price: one-off and permanent, in US cents. */
    paidListingPriceCents: number
    /**
     * Stripe Tax on paid listing checkouts (#68). Tax is deferred: billing refuses to start
     * while this is on, because a taxed charge wouldn't match its order.
     */
    automaticTax: boolean
  }
  site: {
    description: string
    domain: string
    /**
     * Domain of the contact addresses on the legal pages (`dmca@`, `privacy@`). Defaults to
     * `domain`; keep it on a domain whose mailboxes receive mail until Email Routing forwards
     * the site's own addresses.
     */
    legalEmailDomain?: string
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

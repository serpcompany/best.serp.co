import { getListingCategories } from './category-navigation'
import type { WebsiteMedia, WebsitePriority, WebsiteResourceLink } from './website-schema'

export interface ContentMeta {
  filePath: string
  fileName: string
  directory: string
  path: string
  extension: string
  content?: string
}

export interface WebsiteMetadata {
  slug: string
  name: string
  description: string
  website: string
  category: string
  categories?: string[]
  publishedAt: string
  entityType?: string
  isUnofficial?: boolean
  featured?: boolean
  priority?: WebsitePriority
  media?: WebsiteMedia
  content?: string
  resourceLinks?: WebsiteResourceLink[]
  _meta?: ContentMeta
}

export interface WebsiteRelatedCardMetadata {
  slug: string
  name: string
  description: string
  website: string
  isUnofficial?: boolean
  media?: Pick<WebsiteMedia, 'logo'>
}

export interface WebsiteBrowseCardMetadata extends WebsiteRelatedCardMetadata {
  category: string
  categories?: string[]
  publishedAt: string
  featured?: boolean
}

export interface WebsiteNavigationMetadata {
  slug: string
  name: string
  website: string
  media?: Pick<WebsiteMedia, 'logo'>
}

export interface GuideMetadata {
  slug: string
  title: string
  description: string
  date: string
  image?: string
  authors: Array<{ name: string; url?: string }>
  tags?: string[]
  difficulty: 'beginner' | 'intermediate' | 'advanced'
  category: 'getting-started' | 'implementation' | 'best-practices' | 'integration'
  published: boolean
  publishedAt?: string
  readingTime?: number
  content?: string
  _meta?: ContentMeta
}

export interface DocMetadata {
  slug: string
  title: string
  description: string
  order: number
  published: boolean
  content?: string
}

export interface AboutPageMetadata {
  slug: string
  title: string
  description: string
  metaTitle: string
  metaDescription: string
  keywords: string[]
  introTitle: string
  introBody: string
  whatIsTitle: string
  whatIsBody: string
  missionTitle: string
  missionIntro: string
  missionItems: string[]
  stepsTitle?: string
  steps?: Array<{
    icon: 'file-text' | 'code' | 'zap'
    title: string
    body: string
  }>
  communityTitle?: string
  communityBody?: string
  primaryCtaLabel: string
  secondaryCtaLabel: string
  contactTitle?: string
  contactBody?: string
  contactEmail?: string
  published: boolean
  content?: string
}

export interface GuideEntry extends GuideMetadata {
  _meta?: ContentMeta
}

export interface DocEntry extends DocMetadata {
  _meta?: ContentMeta
}

export interface AboutPageEntry extends AboutPageMetadata {
  _meta?: ContentMeta
}

export interface LegalEntry {
  slug?: string
  title?: string
  lastUpdated?: string
  summary?: string
  content?: string
  _meta?: ContentMeta
}

export interface WebsiteDetailMetadata extends WebsiteMetadata {
  relatedWebsites: WebsiteRelatedCardMetadata[]
  previousWebsite: WebsiteNavigationMetadata | null
  nextWebsite: WebsiteNavigationMetadata | null
}

export interface WebsiteLookupIndex {
  websites: readonly WebsiteMetadata[]
  websiteBySlug: ReadonlyMap<string, WebsiteMetadata>
  websiteIndexBySlug: ReadonlyMap<string, number>
}

export function buildWebsiteLookupIndex(websites: readonly WebsiteMetadata[]): WebsiteLookupIndex {
  const websiteBySlug = new Map<string, WebsiteMetadata>()
  const websiteIndexBySlug = new Map<string, number>()

  websites.forEach((website, index) => {
    if (websiteBySlug.has(website.slug)) {
      return
    }

    websiteBySlug.set(website.slug, website)
    websiteIndexBySlug.set(website.slug, index)
  })

  return {
    websites,
    websiteBySlug,
    websiteIndexBySlug
  }
}

function toLogoOnlyMedia(media?: WebsiteMedia): Pick<WebsiteMedia, 'logo'> | undefined {
  return media?.logo ? { logo: media.logo } : undefined
}

function toRelatedCardMetadata(website: WebsiteMetadata): WebsiteRelatedCardMetadata {
  const relatedCard: WebsiteRelatedCardMetadata = {
    slug: website.slug,
    name: website.name,
    description: website.description,
    website: website.website
  }
  const media = toLogoOnlyMedia(website.media)

  if (website.isUnofficial !== undefined) {
    relatedCard.isUnofficial = website.isUnofficial
  }

  if (media) {
    relatedCard.media = media
  }

  return relatedCard
}

export function toWebsiteBrowseCardMetadata(website: WebsiteMetadata): WebsiteBrowseCardMetadata {
  const browseCard: WebsiteBrowseCardMetadata = {
    slug: website.slug,
    name: website.name,
    description: website.description,
    website: website.website,
    category: website.category,
    publishedAt: website.publishedAt
  }
  const media = toLogoOnlyMedia(website.media)

  if (website.categories) {
    browseCard.categories = [...website.categories]
  }

  if (website.featured === true) {
    browseCard.featured = true
  }

  if (website.isUnofficial === true) {
    browseCard.isUnofficial = true
  }

  if (media) {
    browseCard.media = media
  }

  return browseCard
}

function toNavigationMetadata(
  website: WebsiteMetadata | undefined
): WebsiteNavigationMetadata | null {
  if (!website) {
    return null
  }

  const navigationMetadata: WebsiteNavigationMetadata = {
    slug: website.slug,
    name: website.name,
    website: website.website
  }
  const media = toLogoOnlyMedia(website.media)

  if (media) {
    navigationMetadata.media = media
  }

  return navigationMetadata
}

export function resolveWebsiteBySlugFromIndex(
  index: WebsiteLookupIndex,
  slug: string
): WebsiteDetailMetadata | null {
  const { websites, websiteBySlug, websiteIndexBySlug } = index

  if (websites.length === 0) {
    return null
  }

  const website = websiteBySlug.get(slug)

  if (!website) {
    return null
  }

  const currentIndex = websiteIndexBySlug.get(slug)

  if (currentIndex === undefined) {
    return null
  }

  const previousWebsite = toNavigationMetadata(websites[currentIndex - 1])
  const nextWebsite = toNavigationMetadata(websites[currentIndex + 1])
  const websiteCategorySlugs = new Set(getListingCategories(website))
  const relatedWebsites = websites
    .map(site => ({
      sharedCategoryCount: getListingCategories(site).filter(category =>
        websiteCategorySlugs.has(category)
      ).length,
      site
    }))
    .filter(({ sharedCategoryCount, site }) => site.slug !== slug && sharedCategoryCount > 0)
    .sort((left, right) => {
      if (right.sharedCategoryCount !== left.sharedCategoryCount) {
        return right.sharedCategoryCount - left.sharedCategoryCount
      }

      return left.site.name.localeCompare(right.site.name)
    })
    .slice(0, 4)
    .map(({ site }) => toRelatedCardMetadata(site))

  return {
    ...website,
    content: website.content || website._meta?.content || '',
    relatedWebsites,
    previousWebsite,
    nextWebsite
  }
}

export function resolveWebsiteBySlug(
  websites: readonly WebsiteMetadata[],
  slug: string
): WebsiteDetailMetadata | null {
  return resolveWebsiteBySlugFromIndex(buildWebsiteLookupIndex(websites), slug)
}

export function buildGuides(guides: GuideEntry[]): GuideMetadata[] {
  if (!guides || guides.length === 0) {
    return []
  }

  return guides
    .filter(guide => guide.published)
    .map(guide => ({
      title: guide.title || '',
      description: guide.description || '',
      slug: guide.slug || '',
      image: guide.image || undefined,
      difficulty: (guide.difficulty || 'beginner') as 'beginner' | 'intermediate' | 'advanced',
      category: (guide.category || 'getting-started') as
        | 'getting-started'
        | 'implementation'
        | 'best-practices'
        | 'integration',
      published: guide.published !== false,
      publishedAt: guide.publishedAt || guide.date || new Date().toISOString(),
      date: guide.date || new Date().toISOString(),
      authors: guide.authors || []
    }))
    .sort((a, b) => {
      return (
        new Date(b.publishedAt || b.date).getTime() - new Date(a.publishedAt || a.date).getTime()
      )
    })
}

export function resolveGuideBySlug(guides: GuideEntry[], slug: string): GuideMetadata | null {
  const guide = guides.find(currentGuide => currentGuide.slug === slug && currentGuide.published)

  if (!guide) {
    return null
  }

  return {
    slug: guide.slug || slug,
    title: guide.title || 'Untitled Guide',
    description: guide.description || '',
    date: guide.date || new Date().toISOString(),
    authors: guide.authors || [],
    tags: guide.tags || [],
    difficulty: guide.difficulty || 'beginner',
    category: guide.category || 'getting-started',
    published: guide.published !== false,
    publishedAt: guide.publishedAt || guide.date || new Date().toISOString(),
    readingTime: guide.readingTime || 0,
    content: guide.content || guide._meta?.content || ''
  }
}

export function buildDocs(docs: DocEntry[]): DocMetadata[] {
  if (!docs || docs.length === 0) {
    return []
  }

  return docs
    .filter(doc => doc.published)
    .map(doc => ({
      slug: doc.slug || '',
      title: doc.title || '',
      description: doc.description || '',
      order: doc.order ?? 0,
      published: doc.published !== false
    }))
    .sort((a, b) => a.order - b.order)
}

export function resolveDocBySlug(docs: DocEntry[], slug: string): DocMetadata | null {
  const doc = docs.find(currentDoc => currentDoc.slug === slug && currentDoc.published)

  if (!doc) {
    return null
  }

  return {
    slug: doc.slug || slug,
    title: doc.title || 'Untitled',
    description: doc.description || '',
    order: doc.order ?? 0,
    published: doc.published !== false,
    content: doc.content || doc._meta?.content || ''
  }
}

export function resolveAboutPage(aboutPages: AboutPageEntry[]): AboutPageMetadata | null {
  const aboutPage = aboutPages.find(page => page.slug === 'about' && page.published)

  if (!aboutPage) {
    return null
  }

  return {
    slug: aboutPage.slug || 'about',
    title: aboutPage.title || 'About',
    description: aboutPage.description || '',
    metaTitle: aboutPage.metaTitle || aboutPage.title || 'About',
    metaDescription: aboutPage.metaDescription || aboutPage.description || '',
    keywords: aboutPage.keywords || [],
    introTitle: aboutPage.introTitle || aboutPage.title || 'About',
    introBody: aboutPage.introBody || '',
    whatIsTitle: aboutPage.whatIsTitle || '',
    whatIsBody: aboutPage.whatIsBody || '',
    missionTitle: aboutPage.missionTitle || '',
    missionIntro: aboutPage.missionIntro || '',
    missionItems: aboutPage.missionItems || [],
    stepsTitle: aboutPage.stepsTitle || '',
    steps: aboutPage.steps || [],
    communityTitle: aboutPage.communityTitle || '',
    communityBody: aboutPage.communityBody || '',
    primaryCtaLabel: aboutPage.primaryCtaLabel || 'Learn More',
    secondaryCtaLabel: aboutPage.secondaryCtaLabel || 'Browse',
    contactTitle: aboutPage.contactTitle || '',
    contactBody: aboutPage.contactBody || '',
    contactEmail: aboutPage.contactEmail || '',
    published: aboutPage.published !== false,
    content: aboutPage.content || aboutPage._meta?.content || ''
  }
}

export function applyLegalContentBranding(
  content: string,
  options: { siteName: string; domain: string }
): string {
  return content
    .replace(/\{\{siteName\}\}/g, options.siteName)
    .replace(/\{\{domain\}\}/g, options.domain)
    .replace(/privacy@serp\.co/gi, `privacy@${options.domain}`)
    .replace(/legal@serp\.co/gi, `legal@${options.domain}`)
    .replace(/serp\.co/gi, options.domain)
    .replace(/\bSERP\b/g, options.siteName)
}

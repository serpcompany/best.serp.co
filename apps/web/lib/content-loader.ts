import fs from 'node:fs'
import path from 'node:path'
import type {
  AboutPageEntry,
  AboutPageMetadata as AppAboutPageMetadata,
  DocMetadata as AppDocMetadata,
  GuideMetadata as AppGuideMetadata,
  WebsiteMetadata as AppWebsiteMetadata,
  ContentMeta,
  DocEntry,
  GuideEntry,
  LegalEntry
} from '@serpdirectory/web-core/content-query'
import {
  applyLegalContentBranding,
  buildDocs,
  buildGuides,
  resolveAboutPage,
  resolveDocBySlug,
  resolveGuideBySlug
} from '@serpdirectory/web-core/content-query'
import { siteConfig } from '@serpdirectory/web-core/site-config'
import {
  getCanonicalSlugForRedirect,
  getListingBySlug,
  getPublishedListings
} from './catalog/repository'
import { resolveFromRoot } from './server-utils'

export type {
  AboutPageMetadata,
  DocMetadata,
  GuideMetadata,
  WebsiteMetadata
} from '@serpdirectory/web-core/content-query'

interface Resource {
  slug?: string
  title: string
  description: string
  url?: string
  category: string
  icon?: string
  featured?: boolean
  content?: string
  _meta?: ContentMeta
}

let allGuides: GuideEntry[] = []
let allLegals: LegalEntry[] = []
let allResources: Resource[] = []
let allDocs: DocEntry[] = []
let allAboutPages: AboutPageEntry[] = []

try {
  const collections = require('@/.content-collections/generated')
  allGuides = (collections.allGuides || []) as GuideEntry[]
  allLegals = (collections.allLegals || []) as LegalEntry[]
  allResources = (collections.allResources || []) as Resource[]
  allDocs = (collections.allDocs || []) as DocEntry[]
  allAboutPages = (collections.allAboutPages || []) as AboutPageEntry[]
} catch {
  if (process.env.NODE_ENV !== 'test') {
    console.warn('Content collections not available, using empty arrays')
  }
}

function readLegalContentFromFileSystem(key: string): string {
  const legalFilePath = path.join(resolveFromRoot('packages/content/data/legal'), `${key}.mdx`)

  if (!fs.existsSync(legalFilePath)) {
    return ''
  }

  return fs.readFileSync(legalFilePath, 'utf8')
}

export async function getWebsites(): Promise<AppWebsiteMetadata[]> {
  return getPublishedListings()
}

export async function getWebsiteBySlug(slug: string) {
  return getListingBySlug(slug)
}

export async function getWebsiteCanonicalRedirect(slug: string) {
  return getCanonicalSlugForRedirect(slug)
}

export function getGuides(): AppGuideMetadata[] {
  return buildGuides(allGuides)
}

export async function getGuideBySlug(slug: string): Promise<AppGuideMetadata | null> {
  return resolveGuideBySlug(allGuides, slug)
}

export async function getLegalContent(key: string): Promise<string> {
  const legal = allLegals.find(entry => entry._meta?.path === key)
  const content = legal?.content || legal?._meta?.content || readLegalContentFromFileSystem(key)

  if (!content) {
    throw new Error(`Legal content "${key}" not found`)
  }

  return applyLegalContentBranding(content, {
    domain: siteConfig.domain,
    siteName: siteConfig.name
  })
}

export function getResources() {
  return allResources
}

export async function getResourceBySlug(slug: string) {
  const resource = allResources.find(entry => entry.slug === slug)

  if (!resource) {
    return null
  }

  const content = resource.content || resource._meta?.content || ''

  return {
    ...resource,
    content
  }
}

export function getDocs(): AppDocMetadata[] {
  return buildDocs(allDocs)
}

export async function getDocBySlug(slug: string): Promise<AppDocMetadata | null> {
  return resolveDocBySlug(allDocs, slug)
}

export async function getAboutPage(): Promise<AppAboutPageMetadata | null> {
  return resolveAboutPage(allAboutPages)
}

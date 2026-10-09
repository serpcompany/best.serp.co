import { readdirSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * Every listing image renders through one component, `ListingImage`
 * (`apps/web/src/components/listing/listing-image.tsx`, serpcompany/best.serp.co#122), which falls back
 * to the #86 tile and never shows alt text or a broken-image icon. This guard parses the app and
 * shared UI code and fails on any other image element: a raw `<img>`, `next/image`, an avatar
 * image, `<picture>`/`<source>`, or HTML written as a string (comments are not read). The few images that are not
 * listing media (site badges, guide covers, the email logo) are reviewed below, and none of
 * them may take its source from listing media.
 */

const roots = [
  'apps/web/src/app',
  'apps/web/src/components',
  'apps/web/src/lib',
  'apps/web/src/hooks'
]
/** The shared listing image itself. */
const LISTING_IMAGE = 'apps/web/src/components/listing/listing-image.tsx'
/** Images that are not listing media, by file, with why. */
const NON_LISTING_IMAGES: Readonly<Record<string, string>> = {
  'apps/web/src/components/claims/claim-listing.tsx':
    'the "Featured on" badge preview in the claim flow',
  'apps/web/src/components/submit/badge-step.tsx': 'the "Featured on" badge preview',
  'apps/web/src/lib/email/emails/layout.ts': 'the site logo in email HTML',
  'apps/web/src/components/ui/avatar.tsx': 'the avatar primitive (people, not listings)',
  'apps/web/src/components/layout/site-footer.tsx': 'network badges in the footer',
  'apps/web/src/components/content/mdx-components.tsx':
    'Markdown images in site content; listing content holds none (scripts/catalog-media.test.ts)',
  'apps/web/src/components/website/featured-on-badge-embed-panel.tsx':
    'the badge preview and its embed snippet'
}
/** Where `ListingImage` is used: every listing image on the site, admin, account, and submit. */
const LISTING_IMAGE_CALLERS = [
  'apps/web/src/components/admin/mini-listing.tsx',
  'apps/web/src/components/admin/product-cell.tsx',
  'apps/web/src/components/directory/project-navigation.tsx',
  'apps/web/src/components/llm/listing-card.tsx',
  'apps/web/src/components/submit/submit-ui.tsx',
  'apps/web/src/components/website-routes/detail-page.tsx',
  'apps/web/src/components/website/website-content-section.tsx'
]
/** A source that names listing media: a logo, an image list, a featured image, a media key. */
const listingMediaSource = /\b(?:media\w*|logo\w*|images|imageKey|featured\w*)\b/iu
const imageTags = new Set([
  'img',
  'Image',
  'AvatarImage',
  'AvatarPrimitive.Image',
  'picture',
  'source'
])

interface ImageUse {
  line: number
  /** The `src` (or whole string) text, for the listing-media check. */
  source: string
  tag: string
}

/** Image elements, `next/image` imports, and HTML strings holding `<img`, in one file. */
function imageUses(path: string, text: string): ImageUse[] {
  const file = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
  const uses: ImageUse[] = []
  const line = (node: ts.Node) => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1
  const visit = (node: ts.Node): void => {
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      const tag = node.tagName.getText(file)
      if (imageTags.has(tag)) {
        const src = node.attributes.properties.find(
          property => ts.isJsxAttribute(property) && property.name.getText(file) === 'src'
        )
        const spread = node.attributes.properties.some(ts.isJsxSpreadAttribute)
        uses.push({
          line: line(node),
          source: spread ? node.attributes.getText(file) : (src?.getText(file) ?? ''),
          tag
        })
      }
    } else if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === 'next/image'
    ) {
      uses.push({ line: line(node), source: '', tag: 'next/image' })
    } else if (
      (ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateExpression(node)) &&
      /<img\b/iu.test(node.getText(file))
    ) {
      uses.push({ line: line(node), source: node.getText(file), tag: 'html string' })
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return uses
}

function sourceFiles(): string[] {
  return roots
    .flatMap(root =>
      readdirSync(resolve(root), { encoding: 'utf8', recursive: true }).map(file =>
        relative(process.cwd(), resolve(root, file))
      )
    )
    .filter(
      file =>
        /\.tsx?$/u.test(file) &&
        !/\.(?:test|spec|fixture)\.tsx?$/u.test(file) &&
        !file.includes('node_modules') &&
        !file.endsWith('.d.ts')
    )
    .sort()
}

describe('listing images render only through ListingImage (#122)', () => {
  it('finds image elements, next/image, and HTML strings', () => {
    const probe = [
      "import Image from 'next/image'",
      'export const a = <img src={listing.media.logo} alt="" />',
      'export const b = <Image src={website.media?.images?.[0]} alt="" />',
      'export const c = <AvatarImage src={row.logoUrl} />',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: source text holding a template literal
      'export const d = `<img src="${logo}">`',
      'export const e = <ListingImage src={listing.media.logo} name="x" />'
    ].join('\n')
    const uses = imageUses('probe.tsx', probe)
    expect(uses.map(use => use.tag)).toEqual([
      'next/image',
      'img',
      'Image',
      'AvatarImage',
      'html string'
    ])
    expect(uses.filter(use => listingMediaSource.test(use.source))).toHaveLength(4)
  })

  it('renders no image anywhere else, and no reviewed image takes listing media', () => {
    const outside: string[] = []
    const fromListingMedia: string[] = []
    const reviewedSeen = new Set<string>()
    for (const file of sourceFiles()) {
      if (file === LISTING_IMAGE) continue
      for (const use of imageUses(file, readFileSync(resolve(file), 'utf8'))) {
        const label = `${file}:${use.line} ${use.tag}`
        if (!(file in NON_LISTING_IMAGES)) outside.push(label)
        else {
          reviewedSeen.add(file)
          if (use.tag !== 'html string' && listingMediaSource.test(use.source)) {
            fromListingMedia.push(`${label} ${use.source}`)
          }
        }
      }
    }
    expect(
      outside,
      'Render a listing image with ListingImage (@/components/listing/listing-image); add a non-listing image to NON_LISTING_IMAGES with the reason.'
    ).toEqual([])
    expect(fromListingMedia, 'A reviewed non-listing image may not show listing media.').toEqual([])
    // A reviewed entry that no longer renders an image goes, so the list stays exact.
    expect([...reviewedSeen].sort()).toEqual(Object.keys(NON_LISTING_IMAGES).sort())
  })

  it('names every place a listing image renders', () => {
    const callers = sourceFiles().filter(
      file =>
        file !== LISTING_IMAGE &&
        // `@/components/listing/…`, a relative path through `listing/`, or a sibling in it.
        /from '(?:(?:@\/components|\.{1,2}(?:\/[\w.-]+)*)\/listing|\.)\/listing-image'/u.test(
          readFileSync(resolve(file), 'utf8')
        )
    )
    expect(callers).toEqual(LISTING_IMAGE_CALLERS)
  })
})

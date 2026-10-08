/**
 * Classifies what a listing's website shows today (serpcompany/best.serp.co#100). Pure: it reads
 * a `SiteObservation` from `listing-domain-fetch.ts` and the listing row, and decides one of:
 *
 * - `gambling-spam`: the page is a gambling, betting, or spam page (a hijacked domain);
 * - `parking`: the domain is parked or for sale (a parking or marketplace provider);
 * - `off-domain`: it ends on another registrable domain (an acquisition, a rebrand, or a hijack
 *   this check cannot name);
 * - `unreachable`: no page after retries (DNS, TLS, refused, 4xx or 5xx without bot protection);
 * - `ok`.
 *
 * The owner decision of 2026-10-06 unpublishes only the first two. They must be precise, so each
 * needs a strong signal, and a listing that is itself about gambling or domains never gets them
 * from page words alone (it goes to the owner list instead).
 */
import { urlKey } from '../apps/web/src/lib/url-key'
import type { Hop, PageSignals, SiteObservation } from './listing-domain-fetch'

/** Provider fingerprints only count on a page with less visible text than this. */
export const THIN_PAGE_TEXT = 3_000

export const domainClasses = [
  'gambling-spam',
  'parking',
  'off-domain',
  'unreachable',
  'ok'
] as const
export type DomainClass = (typeof domainClasses)[number]
/** Classes the owner decision unpublishes; the rest of the non-`ok` ones go to the owner list. */
export const unpublishClasses: ReadonlySet<DomainClass> = new Set(['gambling-spam', 'parking'])

export interface CheckedListing {
  id: string
  slug: string
  name: string
  description: string
  website: string
}

export interface Classification {
  class: DomainClass
  /** Which trace decided: the listing's link, or its own domain fetched directly. */
  source?: 'own-domain'
  /** Short evidence: why, in a few words. */
  reason: string
  /** The marker that matched (a term, a host, a fingerprint), at most 80 characters. */
  marker: string | null
}

/** The registrable domain (eTLD+1, private suffixes included) of a host, or the host itself. */
export function registrableDomain(host: string): string {
  return urlKey(`https://${host.replace(/^\[|\]$/gu, '')}/`).blockKey
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/\.+$/u, '').toLowerCase()
  } catch {
    return ''
  }
}

/** Link shorteners and affiliate networks a listing's link passes through on its way. */
const REDIRECTORS = new Set([
  'serp.ly',
  'bit.ly',
  'tinyurl.com',
  'rebrand.ly',
  'dub.sh',
  'dub.co',
  't.co',
  'sjv.io',
  'pxf.io',
  '7eer.net',
  'evyy.net',
  'ojrq.net',
  'prf.hn',
  'awin1.com',
  'shareasale.com',
  'linksynergy.com',
  'tkqlhce.com',
  'anrdoezrs.net',
  'dpbolvw.net',
  'jdoqocy.com',
  'kqzyfj.com',
  'clickbank.net',
  'partnerlinks.io',
  'go2cloud.org',
  'pntrac.com',
  'gopjn.com',
  'impact.com'
])
/** True for a link shortener or affiliate network hop. */
export function isRedirectorHost(url: string): boolean {
  const host = hostOf(url)
  return host !== '' && REDIRECTORS.has(registrableDomain(host))
}
/** SERP's own sites: a listing link that ends here is SERP's page for it. */
const SERP_DOMAINS = new Set([
  'serp.ly',
  'serp.co',
  'serp.software',
  'serp.ai',
  'serpdownloaders.com'
])
/** Hosts where a product's own page lives (an extension, an app, a repository). */
const PLATFORM_HOSTS = new Set([
  'chromewebstore.google.com',
  'chrome.google.com',
  'microsoftedge.microsoft.com',
  'addons.mozilla.org',
  'apps.apple.com',
  'play.google.com',
  'github.com',
  'huggingface.co'
])

/**
 * The domain a listing's link should end on: the slug when it is a domain (`gptservice.app`),
 * otherwise the first hop past shorteners and affiliate networks.
 */
export function expectedDomain(listing: CheckedListing, hops: readonly Hop[]): string {
  if (listing.slug.includes('.')) {
    try {
      const key = urlKey(`https://${listing.slug}/`)
      if (key.coversSubdomains) return key.blockKey
    } catch {
      // Not a host name; fall through.
    }
  }
  for (const hop of hops) {
    const domain = registrableDomain(hostOf(hop.url))
    if (domain && !REDIRECTORS.has(domain)) return domain
  }
  return registrableDomain(hostOf(listing.website))
}

interface Marker {
  id: string
  pattern: RegExp
}

/** Word-bounded, case-insensitive, Unicode-aware. */
const term = (id: string, source = id): Marker => ({
  id,
  pattern: new RegExp(`(?<![\\p{L}\\p{N}])${source}(?![\\p{L}\\p{N}])`, 'iu')
})

/**
 * Gambling and betting signals: phrases, not single words, so "casinos and hotels" or "the
 * odds of success" never count. Indonesian and Vietnamese terms cover the hijacks found in
 * #98's review (togel, slot gacor, nhà cái).
 */
export const GAMBLING_TERMS: readonly Marker[] = [
  term('slot gacor'),
  term('gacor'),
  term('situs slot'),
  term('slot online'),
  term('slot88'),
  term('slot777'),
  term('judi online'),
  term('situs judi'),
  term('judi bola'),
  term('judi slot'),
  term('agen judi'),
  term('togel'),
  term('toto macau'),
  term('situs toto'),
  term('maxwin'),
  term('rtp slot'),
  term('rtp live'),
  term('scatter hitam'),
  term('mahjong ways'),
  term('gates of olympus'),
  term('pragmatic play'),
  term('sbobet'),
  term('taruhan'),
  term('agen bola'),
  term('link alternatif'),
  term('link resmi'),
  // Soccer-streaming piracy that runs betting ads on hijacked domains (#104 review).
  term('xoilac', 'xoilac[a-z0-9]*'),
  term('xôi lạc'),
  term('90phut'),
  term('live casino'),
  term('online casino'),
  term('casino online'),
  term('casino bonus'),
  term('free spins'),
  term('no deposit bonus'),
  term('sportsbook'),
  term('sports betting'),
  term('betting odds'),
  term('online betting'),
  term('betting site'),
  term('poker online'),
  term('online poker'),
  term('domino qq'),
  term('nhà cái'),
  term('cá cược'),
  term('cá độ'),
  term('đá gà'),
  term('xổ số'),
  term('tài xỉu'),
  term('nổ hũ'),
  term('bắn cá'),
  term('game bài'),
  term('casino trực tuyến'),
  // Operators seen on hijacked domains (names of three characters or fewer, such as m88, are
  // left out: they turn up in chord names and model numbers).
  ...[
    '1xbet',
    '8xbet',
    '22bet',
    '188bet',
    '12bet',
    'bet365',
    'betway',
    'melbet',
    'mostbet',
    'kubet',
    'jun88',
    'hi88',
    'new88',
    'f8bet',
    'shbet',
    '789bet',
    'mb66',
    'fb88',
    'fun88',
    'sv388',
    'ae888',
    'okvip',
    'dafabet',
    'cmd368',
    'parimatch',
    'betwin188',
    'gerbangwin'
  ].map(brand => term(brand))
]

/** Spam signals: pharmacy and counterfeit spam that keyword-hacked sites carry. */
export const SPAM_TERMS: readonly Marker[] = [
  term('viagra'),
  term('cialis'),
  term('levitra'),
  term('kamagra'),
  term('sildenafil'),
  term('tadalafil'),
  term('replica watches'),
  { id: 'スーパーコピー', pattern: /スーパーコピー/u },
  { id: 'ブランドコピー', pattern: /ブランドコピー/u }
]

/**
 * Indonesian gambling-SEO vocabulary (register, login, official, trusted, spin, daily bonus).
 * Each word is ordinary on its own, so it only counts on a page that left the listing's domain
 * and already carries a gambling term (#98 review: brandfort.co, "SUPER33 ... link alternatif").
 */
const GAMBLING_SEO_WORDS: readonly Marker[] = [
  term('daftar'),
  term('login'),
  term('resmi'),
  term('terpercaya'),
  term('putaran'),
  term('bonus harian'),
  term('jackpot'),
  term('deposit'),
  term('withdraw')
]

/** Words that make a listing itself about gambling: its page may legitimately use the terms. */
const GAMBLING_TOPIC =
  /casino|gambl|\bbet(?:s|ting)?\b|sportsbook|poker|lottery|slot machine|bingo/iu
/** Words that make a listing itself about domain names. */
const DOMAIN_TOPIC = /\bdomains?\b|domain name|registrar|\bparked\b/iu

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

/**
 * True when the listing is itself about `topic`, so its page may use those words. Its name says
 * so, or its description does and the page is its own: on its domain and naming it. A
 * description alone is not enough: some imported descriptions were scraped from the hijacked
 * page itself ("1win Casino: A Comprehensive Guide" for a listing named Phantom).
 */
export function listingIsAbout(
  topic: RegExp,
  listing: CheckedListing,
  page: PageSignals | null,
  offDomain: boolean
): boolean {
  if (topic.test(listing.name)) return true
  if (!topic.test(listing.description) || offDomain || !page) return false
  const name = listing.name.trim()
  if (name.length < 3) return false
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, 'iu').test(
    `${prominentText(page)} ${page.text}`
  )
}

/** Parking and marketplace providers, by registrable domain. */
export const PARKING_HOSTS: ReadonlySet<string> = new Set([
  'sedo.com',
  'sedoparking.com',
  'dan.com',
  'afternic.com',
  'godaddy.com',
  'bodis.com',
  'parkingcrew.net',
  'above.com',
  'hugedomains.com',
  'buydomains.com',
  'undeveloped.com',
  'atom.com',
  'squadhelp.com',
  'brandbucket.com',
  'snagged.com',
  'efty.com',
  'epik.com',
  'sav.com',
  'dynadot.com',
  'spaceship.com',
  'namecheap.com',
  'porkbun.com',
  'uniregistry.com',
  'domainmarket.com',
  'brandpa.com',
  'perfectdomain.com',
  'domainagents.com',
  'namebright.com',
  'parklogic.com',
  'domainnamesales.com',
  'name.com',
  'namesilo.com',
  'hostinger.com',
  'expireddomains.com',
  'expireddomains.net'
])

/** "For sale" and "parked" in a page's title, heading, or description. */
const PARKING_PHRASES: readonly Marker[] = [
  term('is for sale'),
  term('for sale', 'domain(?: name)? (?:is |may be |might be )?for sale'),
  term('buy this domain'),
  term('get this domain'),
  term('make an offer'),
  term('domain is parked'),
  term('parked free'),
  term('parked domain'),
  term('domain parking'),
  term('this page is parked', 'this (?:web )?page is parked'),
  term('domain has expired', 'domain (?:name )?has expired'),
  term('domain is available', 'domain (?:name )?is available'),
  term('inquire about this domain')
]

/** Provider fingerprints in a page's markup (scripts, links, and lander redirects). */
const PARKING_FINGERPRINTS: readonly Marker[] = [
  { id: 'godaddy parking-lander', pattern: /parking-lander|img1\.wsimg\.com\/parking/iu },
  { id: 'godaddy /lander', pattern: /location(?:\.href)?\s*=\s*["']\/lander["']/u },
  { id: 'sedoparking', pattern: /sedoparking\.com|sedo\.com\/(?:search|checkout)/iu },
  { id: 'parkingcrew', pattern: /parkingcrew\.net/iu },
  { id: 'bodis', pattern: /bodis\.com|bodiscdn/iu },
  { id: 'above.com', pattern: /above\.com\/marketplace|park\.above\.com/iu },
  { id: 'dan.com', pattern: /dan\.com\/(?:buy-domain|assets)/iu },
  { id: 'afternic', pattern: /afternic\.com\/(?:forsale|domain)/iu },
  { id: 'hugedomains', pattern: /hugedomains\.com/iu },
  { id: 'spaceship', pattern: /spaceship\.com\/(?:domain|for-sale|lander)/iu },
  { id: 'snagged', pattern: /snagged\.com/iu },
  { id: 'atom', pattern: /atom\.com\/name\//iu },
  { id: 'undeveloped', pattern: /undeveloped\.com/iu },
  { id: 'parklogic', pattern: /parklogic|domainparking/iu }
]

function firstMatch(markers: readonly Marker[], text: string): Marker | null {
  return markers.find(marker => marker.pattern.test(text)) ?? null
}

function matches(markers: readonly Marker[], text: string): Marker[] {
  return markers.filter(marker => marker.pattern.test(text))
}

const short = (value: string) => (value.length > 80 ? `${value.slice(0, 77)}...` : value)

function prominentText(page: PageSignals): string {
  return [page.title, page.description, page.siteName, ...page.headings].filter(Boolean).join(' · ')
}

/**
 * What a visitor reads on a page, including ad image and link labels: the text without scripts,
 * styles, and comments, plus `alt`, `title`, and `aria-label` values. Class names and bundles
 * (`.slot[data-large-columns]`, Radix `data-slot`) never count.
 */
export function visibleWords(html: string): string {
  const cleaned = html
    .slice(0, 2_000_000)
    .replace(/<!--[\s\S]*?-->/gu, ' ')
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/giu, ' ')
  const labels = [
    ...cleaned.matchAll(/\s(?:alt|title|aria-label)\s*=\s*(?:"([^"]*)"|'([^']*)')/giu)
  ].map(match => match[1] ?? match[2] ?? '')
  return `${cleaned.replace(/<[^>]+>/gu, ' ')} ${labels.join(' ')}`.replace(/\s+/gu, ' ')
}

/** Gambling markers in what a page shows (ads included), and how often it says "slot". */
export function markupSignals(html: string): { markers: string[]; slots: number } {
  const words = visibleWords(html)
  return {
    markers: matches([...GAMBLING_TERMS, ...SPAM_TERMS], words).map(marker => marker.id),
    slots: (words.match(/(?<![\p{L}\p{N}])slots?(?![\p{L}\p{N}])/giu) ?? []).length
  }
}

/** Off the listing's domain, a page carrying this many "slot" mentions is a slot-ad page. */
const SLOT_AD_PAGE = 30

/**
 * Gambling or spam: a prominent phrase backed by a second one, four anywhere, one in the host
 * name backed by the page, or, off the listing's domain, one backed by three gambling-SEO words,
 * two in the markup (betting ads), or a page full of slot ads.
 */
export function gamblingSignal(
  page: PageSignals,
  finalHost: string,
  offDomain: boolean
): { marker: string; where: string } | null {
  const prominent = prominentText(page)
  const everywhere = `${prominent} ${page.text}`
  const markers = [...GAMBLING_TERMS, ...SPAM_TERMS]
  const inProminent = matches(markers, prominent)
  const anywhere = matches(markers, everywhere)
  const inHost = matches(markers, finalHost.replace(/[.-]/gu, ' '))
  if (inProminent.length >= 1 && anywhere.length >= 2)
    return { marker: inProminent[0]?.id ?? '', where: 'title or heading' }
  if (anywhere.length >= 4)
    return {
      marker: anywhere
        .slice(0, 3)
        .map(m => m.id)
        .join(', '),
      where: 'page text'
    }
  if (inHost.length >= 1 && anywhere.length >= 1)
    return { marker: inHost[0]?.id ?? '', where: 'host and page' }
  if (offDomain && anywhere.length >= 1 && matches(GAMBLING_SEO_WORDS, everywhere).length >= 3)
    return { marker: anywhere[0]?.id ?? '', where: 'an off-domain page' }
  const known = new Set(markers.map(marker => marker.id))
  const inMarkup = (page.markup?.markers ?? []).filter(id => known.has(id))
  if (offDomain && inMarkup.length >= 2)
    return {
      marker: inMarkup.slice(0, 3).join(', '),
      where: 'the visible content of an off-domain page'
    }
  if (offDomain && (page.markup?.slots ?? 0) >= SLOT_AD_PAGE)
    return { marker: `slot × ${page.markup?.slots}`, where: 'slot ads on an off-domain page' }
  return null
}

/** Parked or for sale: a provider host, a prominent phrase, or a fingerprint on a thin page. */
export function parkingSignal(
  pages: readonly { html: string; prominent: string; textLength: number }[],
  finalDomain: string,
  expected: string
): { marker: string; where: string } | null {
  if (finalDomain !== expected && PARKING_HOSTS.has(finalDomain))
    return { marker: finalDomain, where: 'final host' }
  for (const page of pages) {
    const phrase = firstMatch(PARKING_PHRASES, page.prominent)
    if (phrase) return { marker: phrase.id, where: 'title or heading' }
    const fingerprint = firstMatch(PARKING_FINGERPRINTS, page.html)
    if (fingerprint && page.textLength < THIN_PAGE_TEXT)
      return { marker: fingerprint.id, where: 'markup' }
  }
  return null
}

const PROTECTION = /cloudflare|akamai|ddos-guard|sucuri|vercel|imperva|incapsula/iu

/** True when some hop of the trace was on the listing's own registrable domain. */
export function reachedOwnDomain(listing: CheckedListing, observation: SiteObservation): boolean {
  const expected = expectedDomain(listing, observation.hops)
  return observation.hops.some(hop => registrableDomain(hostOf(hop.url)) === expected)
}

/**
 * The listing's own domain, to fetch directly, when its slug is a domain and its link never
 * reached it (the link points at another domain, or failed on the way). Null otherwise.
 */
export function ownDomainUrl(listing: CheckedListing, observation: SiteObservation): string | null {
  if (!listing.slug.includes('.') || reachedOwnDomain(listing, observation)) return null
  try {
    if (!urlKey(`https://${listing.slug}/`).coversSubdomains) return null
  } catch {
    return null
  }
  return `https://${listing.slug}/`
}

/**
 * Classifies the listing from its link's trace and, when the link never reached the listing's
 * own domain, from that domain fetched directly. A parked or for-sale page counts only on the
 * listing's own domain; a link to another, parked domain is an off-domain link for the owner.
 */
export function classifyListing(
  listing: CheckedListing,
  observation: SiteObservation,
  own?: SiteObservation | null
): Classification {
  const link = classifyTrace(listing, observation)
  if (link.class === 'gambling-spam' || link.class === 'parking' || !own) return link
  const direct = classifyTrace(listing, own)
  if (direct.class !== 'gambling-spam' && direct.class !== 'parking') return link
  // The own domain is the only signal. If the link still lands on a live, unflagged site (an
  // acquisition: banterai.business → 0-holdings.com), the listing may have moved: owner review.
  if (observation.result === 'page')
    return {
      class: 'off-domain',
      reason: `own domain is ${direct.class === 'parking' ? 'parked or for sale' : 'gambling or spam'}, but the link lands on a live site: owner review`,
      marker: direct.marker,
      source: 'own-domain'
    }
  return { ...direct, reason: `own domain: ${direct.reason}`, source: 'own-domain' }
}

function classifyTrace(listing: CheckedListing, observation: SiteObservation): Classification {
  const finalHost = hostOf(observation.finalUrl)
  const finalDomain = finalHost ? registrableDomain(finalHost) : ''
  const expected = expectedDomain(listing, observation.hops)
  const offDomain =
    finalDomain !== '' &&
    finalDomain !== expected &&
    !SERP_DOMAINS.has(finalDomain) &&
    !PLATFORM_HOSTS.has(finalHost) &&
    !REDIRECTORS.has(finalDomain)
  const page = observation.page
  const aboutGambling = listingIsAbout(GAMBLING_TOPIC, listing, page, offDomain)
  const aboutDomains = listingIsAbout(DOMAIN_TOPIC, listing, page, offDomain)

  const gambling = page ? gamblingSignal(page, finalHost, offDomain) : null
  if (gambling) {
    if (!aboutGambling)
      return {
        class: 'gambling-spam',
        reason: `gambling or spam terms in ${gambling.where}`,
        marker: short(gambling.marker)
      }
    return {
      class: 'off-domain',
      reason: 'gambling terms, but the listing is about gambling: owner review',
      marker: short(gambling.marker)
    }
  }

  const pages = [
    ...observation.stubs.map(html => ({ html, prominent: '', textLength: 0 })),
    ...(page
      ? [{ html: page.html, prominent: prominentText(page), textLength: page.text.length }]
      : [])
  ]
  const parking = parkingSignal(pages, finalDomain, expected)
  if (parking) {
    if (!reachedOwnDomain(listing, observation))
      return {
        class: 'off-domain',
        reason: `parked or for sale, but on ${finalDomain}, not the listing's ${expected}: owner review`,
        marker: short(parking.marker)
      }
    if (!aboutDomains)
      return {
        class: 'parking',
        reason: `parked or for sale (${parking.where})`,
        marker: short(parking.marker)
      }
    return {
      class: 'off-domain',
      reason: 'parking signal, but the listing is about domains: owner review',
      marker: short(parking.marker)
    }
  }

  if (observation.result === 'too_many_redirects')
    return {
      class: 'unreachable',
      reason: `too_many_redirects (${observation.hops.length} hops, stopped on ${finalDomain})`,
      marker: null
    }
  if (offDomain)
    return {
      class: 'off-domain',
      reason: `ends on ${finalDomain}, not ${expected}`,
      marker: short(finalHost)
    }

  if (observation.result === 'page') return { class: 'ok', reason: 'page', marker: null }
  const last = observation.hops.at(-1)
  const protectedResponse =
    (observation.status === 401 || observation.status === 403 || observation.status === 429) &&
    (last?.challenge === true || PROTECTION.test(last?.server ?? ''))
  if (
    protectedResponse ||
    observation.result === 'unexpected_type' ||
    observation.result === 'response_too_large'
  )
    return { class: 'ok', reason: `reachable (${observation.result})`, marker: null }
  return {
    class: 'unreachable',
    reason: observation.error ? `${observation.result} (${observation.error})` : observation.result,
    marker: null
  }
}

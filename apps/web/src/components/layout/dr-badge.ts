export type DrBadgeConfig = {
  alt: string
  href: string
  src: string
}

const drScoresByDomain = {
  'browserextensions.io': 39,
  'pornvideodownloaders.com': 16,
  'serp.ai': 69,
  'serp.co': 78,
  'serp.software': 27,
  'serpdownloaders.com': 27
} as const

export function resolveDrBadgeConfig(domain: string): DrBadgeConfig | undefined {
  const normalizedDomain = domain.toLowerCase()
  const drScore = drScoresByDomain[normalizedDomain as keyof typeof drScoresByDomain]

  if (!drScore) {
    return undefined
  }

  return {
    alt: `Verified DR ${drScore} for ${normalizedDomain}`,
    href: `https://dr.serp.co/sites/${normalizedDomain}`,
    src: `https://dr.serp.co/badge/${normalizedDomain}?style=serp-dr-v3`
  }
}

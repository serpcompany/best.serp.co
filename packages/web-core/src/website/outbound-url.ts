type OutboundRefConfig = {
  domain?: string | null
  publicUrl?: string | null
}

function resolveRefDomain(config: OutboundRefConfig): string | null {
  const configuredDomain = config.domain?.trim()

  if (configuredDomain) {
    return configuredDomain
  }

  const publicUrl = config.publicUrl?.trim()

  if (!publicUrl) {
    return null
  }

  try {
    return new URL(publicUrl).hostname || null
  } catch {
    return null
  }
}

export function getOutboundUrlWithRef(url: string, config: OutboundRefConfig): string {
  const refDomain = resolveRefDomain(config)

  if (!refDomain) {
    return url
  }

  try {
    const parsedUrl = new URL(url)

    if (parsedUrl.searchParams.has('ref')) {
      return url
    }

    parsedUrl.searchParams.set('ref', refDomain)

    return parsedUrl.toString()
  } catch {
    return url
  }
}

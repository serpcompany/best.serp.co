interface JsonLdProps {
  data: Record<string, unknown>
}

/**
 * Structured data. It reads no request header: anonymous pages are stored in the shared edge
 * HTML cache, so a request-controlled value here (such as a client-sent `x-nonce`) would be
 * served to every later visitor (serpcompany/best.serp.co#41 review). A future nonce-based CSP
 * needs a nonce the Worker generates per response, not one taken from the request.
 */
export function JsonLd({ data }: JsonLdProps) {
  const safeJson = JSON.stringify(data).replace(/</g, '\\u003c')

  return (
    <script
      type="application/ld+json"
      suppressHydrationWarning
      // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD requires unescaped JSON; content is sanitized above by escaping < to \u003c
      dangerouslySetInnerHTML={{ __html: safeJson }}
    />
  )
}

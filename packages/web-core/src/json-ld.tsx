import { headers } from 'next/headers'

interface JsonLdProps {
  data: Record<string, any>
}

function isStaticExportBuild(): boolean {
  return process.env.STATIC_EXPORT === 'true'
}

export async function JsonLd({ data }: JsonLdProps) {
  const nonce = isStaticExportBuild()
    ? undefined
    : (await headers()).get('x-nonce') ?? undefined
  const safeJson = JSON.stringify(data).replace(/</g, '\\u003c')

  return (
    <script
      type="application/ld+json"
      nonce={nonce}
      suppressHydrationWarning
      // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD requires unescaped JSON; content is sanitized above by escaping < to \u003c
      dangerouslySetInnerHTML={{ __html: safeJson }}
    />
  )
}

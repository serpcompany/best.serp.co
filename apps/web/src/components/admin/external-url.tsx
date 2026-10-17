import { ExternalLink } from 'lucide-react'

/** The parsed `value` when it is an `http:` or `https:` URL, else null (#492). */
function httpHref(value: string): string | null {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

/**
 * A submitted website in monospace, as a link that opens it in a new tab when it is an http(s)
 * URL (#492). Any other value stays plain text, so a `javascript:` or `ftp:` value is never a link.
 */
export function ExternalUrl({ url }: { url: string }) {
  const href = httpHref(url)
  if (!href) return <span className="font-mono text-[13px]">{url}</span>
  return (
    <a
      className="font-mono text-[13px] underline-offset-4 hover:underline"
      href={href}
      rel="noopener noreferrer nofollow"
      target="_blank"
    >
      {url}
      <ExternalLink aria-hidden className="ml-1 inline size-3.5 align-text-bottom" />
    </a>
  )
}

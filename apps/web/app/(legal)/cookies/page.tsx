import { permanentRedirect } from 'next/navigation'

export default function LegacyCookiesPage() {
  permanentRedirect('/legal/cookies')
}

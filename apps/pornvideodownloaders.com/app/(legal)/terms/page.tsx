import { permanentRedirect } from 'next/navigation'

export default function LegacyTermsPage() {
  permanentRedirect('/legal/terms')
}

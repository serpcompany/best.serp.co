import type { ReactNode } from 'react'
import { SiteChrome } from '@/components/layout/site-chrome'

/** The public site: header, footer, and one `<main>` around every page. */
export default function SiteLayout({ children }: { children: ReactNode }) {
  return <SiteChrome>{children}</SiteChrome>
}

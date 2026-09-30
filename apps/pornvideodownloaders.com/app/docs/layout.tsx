import { DocsRouteLayout } from '@serpdirectory/web-core/docs/layout'
import type { ReactNode } from 'react'
import { getDocs } from '@/lib/content-loader'

export default function DocsLayout({ children }: { children: ReactNode }) {
  return <DocsRouteLayout docs={getDocs()}>{children}</DocsRouteLayout>
}

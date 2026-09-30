import type { ReactNode } from 'react'
import type { DocMetadata } from '../content-query'
import { DocsSidebar } from './sidebar'

interface DocsRouteLayoutProps {
  children: ReactNode
  docs: DocMetadata[]
}

export function DocsRouteLayout({ children, docs }: DocsRouteLayoutProps) {
  return (
    <div className="container mx-auto py-8">
      <div className="grid grid-cols-1 lg:grid-cols-[220px_1fr] gap-8 lg:gap-12">
        <DocsSidebar docs={docs} />
        <main className="min-w-0">{children}</main>
      </div>
    </div>
  )
}

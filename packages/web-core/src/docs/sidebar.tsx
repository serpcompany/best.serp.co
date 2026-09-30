'use client'

import { cn } from '@serpdirectory/design-system/lib/utils'
import { BookOpen, Bot, FileJson, Github, SwatchBook, Terminal } from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { DocMetadata } from '../content-query'
import { getRoute } from '../routes'
import { siteCopy } from '../site-copy'

const DOC_ICONS: Record<string, typeof BookOpen> = {
  'getting-started': BookOpen,
  commands: Terminal,
  agents: Bot,
  'submit-workflow': Github,
  'json-shapes': FileJson,
  'rebrand-checklist': SwatchBook
}

interface DocsSidebarProps {
  docs: DocMetadata[]
}

export function DocsSidebar({ docs }: DocsSidebarProps) {
  const pathname = usePathname()

  return (
    <aside className="lg:sticky lg:top-20 lg:self-start">
      <nav className="space-y-1">
        <h3 className="font-semibold text-sm mb-3 text-muted-foreground uppercase tracking-wider">
          {siteCopy.docsLabel}
        </h3>
        {docs.map(doc => {
          const href =
            doc.slug === 'getting-started'
              ? getRoute('docs.list')
              : getRoute('docs.doc', { slug: doc.slug })
          const isActive =
            pathname === href ||
            (pathname === getRoute('docs.list') && doc.slug === 'getting-started')
          const Icon = DOC_ICONS[doc.slug] || BookOpen

          return (
            <Link
              key={doc.slug}
              href={href}
              className={cn(
                'flex items-center gap-2.5 px-3 py-2 text-sm rounded-md transition-colors',
                isActive
                  ? 'bg-accent text-foreground font-medium'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {doc.title}
            </Link>
          )
        })}
      </nav>
    </aside>
  )
}

import Link from 'next/link'
import type { Components } from 'react-markdown'
import { cn } from '@/lib/utils'
import { withDubVia } from '../../lib/analytics/dub-via'

/**
 * The site's Markdown elements, for react-markdown. Each one drops react-markdown's `node` prop
 * (the element's syntax tree), which would otherwise reach the DOM as `node="[object Object]"`.
 */
export const components: Components = {
  h1: () => {
    // Return null to skip rendering the H1 from markdown
    return null
  },
  h2: ({ node: _node, className, ...props }) => (
    <h2
      className={cn(
        'mt-10 scroll-m-20 border-b pb-1 text-2xl font-semibold tracking-tight first:mt-0',
        className
      )}
      {...props}
    />
  ),
  h3: ({ node: _node, className, ...props }) => (
    <h3
      className={cn('mt-8 scroll-m-20 text-2xl font-semibold tracking-tight', className)}
      {...props}
    />
  ),
  h4: ({ node: _node, className, ...props }) => (
    <h4
      className={cn('mt-8 scroll-m-20 text-xl font-semibold tracking-tight', className)}
      {...props}
    />
  ),
  h5: ({ node: _node, className, ...props }) => (
    <h5
      className={cn('mt-8 scroll-m-20 text-lg font-semibold tracking-tight', className)}
      {...props}
    />
  ),
  h6: ({ node: _node, className, ...props }) => (
    <h6
      className={cn('mt-8 scroll-m-20 text-base font-semibold tracking-tight', className)}
      {...props}
    />
  ),
  a: ({ node: _node, className, ...props }) => (
    <Link
      className={cn('font-medium underline underline-offset-4', className)}
      {...props}
      // Listing body text links to serp.ly too (#169).
      href={withDubVia(props.href || '#')}
    />
  ),
  p: ({ node: _node, className, ...props }) => (
    <p className={cn('leading-7 [&:not(:first-child)]:mt-6', className)} {...props} />
  ),
  ul: ({ node: _node, className, ...props }) => (
    <ul className={cn('my-6 ml-6 list-disc', className)} {...props} />
  ),
  ol: ({ node: _node, className, ...props }) => (
    <ol className={cn('my-6 ml-6 list-decimal', className)} {...props} />
  ),
  li: ({ node: _node, className, ...props }) => <li className={cn('mt-2', className)} {...props} />,
  blockquote: ({ node: _node, className, ...props }) => (
    <blockquote
      className={cn('mt-6 border-l-2 pl-6 italic [&>*]:text-muted-foreground', className)}
      {...props}
    />
  ),
  img: ({ node: _node, className, alt, ...props }) => (
    <img className={cn('rounded-md', className)} alt={alt} {...props} />
  ),
  hr: ({ node: _node, ...props }) => <hr className="my-4 md:my-8" {...props} />,
  table: ({ node: _node, className, ...props }) => (
    <div className="my-6 w-full overflow-y-auto">
      <table className={cn('w-full', className)} {...props} />
    </div>
  ),
  tr: ({ node: _node, className, ...props }) => (
    <tr className={cn('m-0 border-t p-0 even:bg-muted', className)} {...props} />
  ),
  th: ({ node: _node, className, ...props }) => (
    <th
      className={cn(
        'border px-4 py-2 text-left font-bold [&[align=center]]:text-center [&[align=right]]:text-right',
        className
      )}
      {...props}
    />
  ),
  td: ({ node: _node, className, ...props }) => (
    <td
      className={cn(
        'border px-4 py-2 text-left [&[align=center]]:text-center [&[align=right]]:text-right',
        className
      )}
      {...props}
    />
  ),
  pre: ({ node: _node, className, ...props }) => (
    <pre
      className={cn(
        'mb-4 mt-6 overflow-x-auto rounded-md border border-border/50 p-4 text-sm',
        'bg-muted',
        '[&_code]:bg-transparent [&_code]:p-0 [&_code]:text-foreground',
        '[&_code_span]:bg-transparent',
        className
      )}
      {...props}
    />
  ),
  code: ({ node: _node, className, ...props }) => (
    <code
      className={cn(
        'font-mono text-sm relative rounded-sm bg-muted/80 px-1.5 py-0.5 text-foreground',
        className
      )}
      {...props}
    />
  )
}

import type { VariantProps } from 'class-variance-authority'
import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'
import { pageContainerVariants, pageSectionVariants } from './page-shell.styles'

type PageContainerProps = HTMLAttributes<HTMLDivElement> &
  VariantProps<typeof pageContainerVariants>

/** The centered, padded column every page and the shell's header and footer sit in. */
export function PageContainer({ children, className, width, ...props }: PageContainerProps) {
  const resolvedWidth = width ?? 'content'
  return (
    <div
      className={cn(pageContainerVariants({ width: resolvedWidth }), className)}
      data-page-container={resolvedWidth}
      {...props}
    >
      {children}
    </div>
  )
}

type PageSectionProps = HTMLAttributes<HTMLElement> &
  VariantProps<typeof pageSectionVariants> &
  VariantProps<typeof pageContainerVariants> & {
    as?: 'div' | 'section'
    containerClassName?: string
  }

/** A vertical band of a page with the shared spacing, holding a `PageContainer`. */
export function PageSection({
  as: Component = 'section',
  children,
  className,
  containerClassName,
  spacing,
  width,
  ...props
}: PageSectionProps) {
  return (
    <Component className={cn(pageSectionVariants({ spacing }), className)} {...props}>
      <PageContainer className={containerClassName} width={width}>
        {children}
      </PageContainer>
    </Component>
  )
}

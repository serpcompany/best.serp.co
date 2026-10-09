import { cva, type VariantProps } from 'class-variance-authority'

/**
 * The page container and section spacing the SERP sites share (serplists'
 * `page-shell.styles.ts`, #256). best.serp.co's shell and content run at `max-w-7xl`, like
 * serp.co's catalog (#253).
 */
export const pageContainerVariants = cva('mx-auto w-full px-4 md:px-6', {
  variants: {
    width: {
      shell: 'max-w-7xl',
      content: 'max-w-7xl',
      narrow: 'max-w-4xl',
      docs: 'max-w-4xl'
    }
  },
  defaultVariants: {
    width: 'content'
  }
})

export const pageSectionVariants = cva('', {
  variants: {
    spacing: {
      compact: 'py-6',
      default: 'py-8',
      spacious: 'py-12',
      hero: 'pt-12 pb-10 sm:pt-16 sm:pb-12'
    }
  },
  defaultVariants: {
    spacing: 'default'
  }
})

export type PageContainerWidth = VariantProps<typeof pageContainerVariants>['width']

export const pageHeroVariants = cva('flex flex-col gap-4', {
  variants: {
    align: {
      left: 'items-start text-left',
      center: 'items-center text-center'
    }
  },
  defaultVariants: {
    align: 'left'
  }
})

export const iconTileVariants = cva(
  'flex shrink-0 items-center justify-center rounded-lg text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      size: {
        sm: "size-8 [&_svg:not([class*='size-'])]:size-4",
        md: "size-10 [&_svg:not([class*='size-'])]:size-5",
        lg: "size-14 rounded-xl [&_svg:not([class*='size-'])]:size-6"
      },
      tone: {
        muted: 'bg-muted',
        card: 'bg-card ring-1 ring-foreground/10'
      }
    },
    defaultVariants: {
      size: 'md',
      tone: 'muted'
    }
  }
)

import * as DesignSystemCard from '@/components/ui/card'
import { cn } from '@/lib/utils'

/**
 * The site's public card. `ui/card.tsx` is the stock shadcn card; these classes keep
 * the public pages' look: square corners, a lighter border, p-4, and the hover lift.
 */
const publicCardClassName =
  'rounded-none border-border/50 p-4 transition-all duration-300 ease-out hover:-translate-y-1 hover:border-foreground/10 hover:shadow-lg'

export function Card({ className, ...props }: React.ComponentProps<typeof DesignSystemCard.Card>) {
  return <DesignSystemCard.Card className={cn(publicCardClassName, className)} {...props} />
}

/** The stock header is a grid; public pages keep their stacked header with a 1.5 gap. */
export function CardHeader({
  className,
  ...props
}: React.ComponentProps<typeof DesignSystemCard.CardHeader>) {
  return (
    <DesignSystemCard.CardHeader
      className={cn('flex flex-col items-stretch gap-1.5', className)}
      {...props}
    />
  )
}

export function CardTitle({
  className,
  ...props
}: React.ComponentProps<typeof DesignSystemCard.CardTitle>) {
  return <DesignSystemCard.CardTitle className={className} {...props} />
}

export function CardDescription({
  className,
  ...props
}: React.ComponentProps<typeof DesignSystemCard.CardDescription>) {
  return <DesignSystemCard.CardDescription className={className} {...props} />
}

export function CardContent({
  className,
  ...props
}: React.ComponentProps<typeof DesignSystemCard.CardContent>) {
  return <DesignSystemCard.CardContent className={className} {...props} />
}

import * as DesignSystemCard from '@/components/ui/card'
import { cn } from '@/lib/utils'

/**
 * The site's public card: the stock Card with the public pages' look (square corners, a
 * lighter border, p-4, and the hover lift). Its other parts are the stock ones from `ui/card`.
 */
const publicCardClassName =
  'border-border/50 p-4 transition-all duration-300 ease-out hover:-translate-y-1 hover:border-foreground/10 hover:shadow-lg'

export function SiteCard({
  className,
  ...props
}: React.ComponentProps<typeof DesignSystemCard.Card>) {
  return <DesignSystemCard.Card className={cn(publicCardClassName, className)} {...props} />
}

/** The stock header is a grid; public pages keep their stacked header with a 1.5 gap. */
export function SiteCardHeader({
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

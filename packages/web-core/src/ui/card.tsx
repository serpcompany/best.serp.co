import * as DesignSystemCard from '@serpdirectory/design-system/card'
import { cn } from '@serpdirectory/design-system/lib/utils'

export function Card({ className, ...props }: React.ComponentProps<typeof DesignSystemCard.Card>) {
  return (
    <DesignSystemCard.Card className={cn('rounded-none border-border/50', className)} {...props} />
  )
}

export function CardHeader({
  className,
  ...props
}: React.ComponentProps<typeof DesignSystemCard.CardHeader>) {
  return <DesignSystemCard.CardHeader className={className} {...props} />
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

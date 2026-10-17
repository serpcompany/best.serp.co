import { BadgeCheck } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

/**
 * The public "Claimed" badge (#535, which replaced #70 screen 9b's "Verified owner"): a listing
 * with a current owner shows it next to its name, with a tooltip. Listing pages only, not cards.
 */
export function ClaimedBadge() {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<Badge variant="outline" className="border-success/30 text-success" tabIndex={0} />}
      >
        <BadgeCheck aria-hidden="true" />
        Claimed
      </TooltipTrigger>
      <TooltipContent>The maker verified ownership of this listing</TooltipContent>
    </Tooltip>
  )
}

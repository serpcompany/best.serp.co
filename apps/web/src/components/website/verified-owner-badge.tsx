import { Badge } from '@serpdirectory/design-system/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@serpdirectory/design-system/tooltip'
import { BadgeCheck } from 'lucide-react'

/**
 * The public "Verified owner" badge (owner decision on #59; #70 screen 9b): a listing with a
 * current owner shows it next to its name, with a tooltip. Listing pages only, not cards.
 */
export function VerifiedOwnerBadge() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="secondary" tabIndex={0}>
          <BadgeCheck aria-hidden="true" />
          Verified owner
        </Badge>
      </TooltipTrigger>
      <TooltipContent>The maker verified ownership of this listing</TooltipContent>
    </Tooltip>
  )
}

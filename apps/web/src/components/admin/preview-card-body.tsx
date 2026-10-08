import { TriangleAlert } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import type { ListingDetail } from '@/db/contracts'
import { MiniListing } from './mini-listing'

/** The preview card's body: the mini listing, or why the staged content cannot be shown. */
export function PreviewCardBody({
  categoryName,
  preview
}: {
  categoryName: string | null
  preview: { error: string } | { listing: ListingDetail }
}) {
  if ('error' in preview) {
    return (
      <Alert className="border-amber-500/40 bg-card text-amber-700 dark:text-amber-400">
        <TriangleAlert />
        <AlertTitle>The preview can’t be shown</AlertTitle>
        <AlertDescription className="text-muted-foreground">{preview.error}</AlertDescription>
      </Alert>
    )
  }
  return <MiniListing categoryName={categoryName} listing={preview.listing} />
}

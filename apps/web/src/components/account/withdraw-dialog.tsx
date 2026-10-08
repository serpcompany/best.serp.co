'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { toast } from 'sonner'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { buttonVariants } from '@/components/ui/button'
import { withdrawSubmission } from './account-api'

/**
 * "Withdraw <name>?" (#70 screen 6, AlertDialog). Only offered before payment (#59 owner
 * decision); the server refuses anything else. On success the page reloads its data.
 */
export function WithdrawDialog({
  inQueue,
  name,
  onOpenChange,
  open,
  submissionId
}: {
  /** In the review queue: "It leaves the review queue…". */
  inQueue: boolean
  name: string
  onOpenChange: (open: boolean) => void
  open: boolean
  submissionId: string
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  async function confirm() {
    setBusy(true)
    const response = await withdrawSubmission(submissionId)
    setBusy(false)
    if (!response.ok) {
      toast.error(response.error.error)
      return
    }
    onOpenChange(false)
    toast.success(`${name} was withdrawn.`)
    router.refresh()
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Withdraw {name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {inQueue
              ? 'It leaves the review queue and won’t be published. To list it later, you’ll need to submit it again.'
              : 'It won’t be reviewed or published. To list it later, you’ll need to submit it again.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className={buttonVariants({ variant: 'destructive' })}
            disabled={busy}
            onClick={event => {
              event.preventDefault()
              void confirm()
            }}
          >
            Withdraw submission
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

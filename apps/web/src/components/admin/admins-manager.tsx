'use client'

import { Info, Plus } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { toast } from 'sonner'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
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
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { formatLongDate, initials } from '@/lib/admin/format'
import { adminRequest } from './api'

/**
 * The admin allowlist (#64 screen 14): the list with Remove (disabled, with a tooltip, for the
 * last admin), and the "Add an admin" card. Adding grants access at the next sign-in; removing
 * revokes it on the next request.
 */

export interface AdminRow {
  addedAt: string | null
  addedBy: string
  email: string
  name: string | null
}

export function AdminsManager({
  admins,
  currentEmail
}: {
  admins: AdminRow[]
  currentEmail: string
}) {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [addError, setAddError] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const last = admins.length <= 1

  const add = async () => {
    setBusy(true)
    setAddError(null)
    const result = await adminRequest<{ email: string }>('/api/admin/admins', { email })
    setBusy(false)
    if (!result.ok) {
      setAddError(result.message)
      return
    }
    if (result.replayed) {
      setAddError(`${result.email} is already an admin.`)
      return
    }
    toast.success(`${result.email} can open /admin at their next sign-in.`)
    setEmail('')
    router.refresh()
  }

  const remove = async (target: string) => {
    setBusy(true)
    setRemoveError(null)
    const result = await adminRequest('/api/admin/admins', { email: target }, 'DELETE')
    setBusy(false)
    if (!result.ok) {
      setRemoveError(result.message)
      return
    }
    setRemoving(null)
    toast.success(`${target} is no longer an admin.`)
    if (target === currentEmail) {
      router.replace('/')
      return
    }
    router.refresh()
  }

  const removeButton = (row: AdminRow) => {
    if (last) {
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            {/* aria-disabled, not disabled, so the button can still be focused for the tooltip. */}
            <Button
              variant="outline"
              size="sm"
              aria-disabled="true"
              className="cursor-not-allowed opacity-50"
              onClick={event => event.preventDefault()}
            >
              Remove
            </Button>
          </TooltipTrigger>
          <TooltipContent>The last admin can’t be removed</TooltipContent>
        </Tooltip>
      )
    }
    return (
      <Button
        variant="outline"
        size="sm"
        className="text-destructive"
        onClick={() => setRemoving(row.email)}
      >
        Remove
      </Button>
    )
  }

  return (
    <>
      {last ? (
        <Alert>
          <Info />
          <AlertTitle>You’re the only admin</AlertTitle>
          <AlertDescription>
            Add another admin before you can remove yourself, so someone can always review
            submissions.
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="overflow-hidden rounded-lg border">
        <Table>
          <TableHeader className="bg-muted">
            <TableRow>
              <TableHead className="text-foreground first:pl-4">Email</TableHead>
              <TableHead className="text-foreground">Added</TableHead>
              <TableHead className="text-foreground">Added by</TableHead>
              <TableHead className="text-right text-foreground last:pr-4">
                <span className="sr-only">Remove</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {admins.map(row => (
              <TableRow key={row.email}>
                <TableCell className="first:pl-4">
                  <div className="flex items-center gap-2">
                    <Avatar>
                      <AvatarFallback>{initials(row.email, row.name)}</AvatarFallback>
                    </Avatar>
                    <span className="font-medium">{row.email}</span>
                    {row.email === currentEmail ? <Badge variant="secondary">You</Badge> : null}
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {formatLongDate(row.addedAt)}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {row.addedBy.startsWith('migration') ? 'Seeded by migration' : row.addedBy}
                </TableCell>
                <TableCell className="last:pr-4">
                  <div className="flex justify-end">{removeButton(row)}</div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Add an admin</CardTitle>
          <CardDescription>
            They get admin access the next time they sign in with this email.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-col gap-3 md:flex-row md:items-start"
            onSubmit={event => {
              event.preventDefault()
              void add()
            }}
          >
            <Field className="flex-1" data-invalid={addError ? true : undefined}>
              <FieldLabel htmlFor="admin-email">Email</FieldLabel>
              <Input
                id="admin-email"
                type="email"
                placeholder="name@serp.co"
                value={email}
                aria-invalid={addError ? true : undefined}
                onChange={event => setEmail(event.target.value)}
              />
              {addError ? <FieldError>{addError}</FieldError> : null}
            </Field>
            <div className="md:pt-[30px]">
              <Button type="submit" disabled={busy || !email.trim()}>
                <Plus />
                Add admin
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <AlertDialog
        open={removing !== null}
        onOpenChange={open => {
          if (!open) {
            setRemoving(null)
            setRemoveError(null)
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing} as an admin?</AlertDialogTitle>
            <AlertDialogDescription>
              They lose access to /admin right away. Their own account and listings stay as they
              are.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {removeError ? <FieldError>{removeError}</FieldError> : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={event => {
                event.preventDefault()
                if (removing) void remove(removing)
              }}
            >
              Remove admin
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

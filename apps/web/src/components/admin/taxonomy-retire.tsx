'use client'

import { useRouter } from 'next/navigation'
import { useId, useState } from 'react'
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
import { Button } from '@/components/ui/button'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { adminRequest } from './api'

/**
 * Retiring a category, tag, or best page (#405): a destructive outline button and a stock
 * `AlertDialog` that asks where its URL redirects (a 308): another active category, tag, or best
 * page, or the directory. The decision refuses a retirement that would strand a live listing.
 */

/** A page a retired one can redirect to, as `<kind>:<slug>`, or `directory`. */
export interface RedirectChoice {
  label: string
  value: string
}

export interface RedirectChoices {
  bestPages: RedirectChoice[]
  categories: RedirectChoice[]
  tags: RedirectChoice[]
}

const DIRECTORY = { label: 'All products (/products/)', value: 'directory' }

function target(value: string) {
  if (value === 'directory') return { kind: 'directory' }
  const [kind, slug] = value.split(':')
  return { kind, slug }
}

export function RetireTaxonomy({
  action,
  choices,
  defaultTarget,
  doneHref,
  name
}: {
  /** The retire endpoint: `/api/admin/<kind>/<slug>/retire`. */
  action: string
  choices: RedirectChoices
  /** The choice the dialog opens with. */
  defaultTarget: string
  /** Where the page goes once it is retired: the list it was on. */
  doneHref: string
  name: string
}) {
  const id = useId()
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState(defaultTarget)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const groups = [
    { label: 'Categories', items: choices.categories },
    { label: 'Tags', items: choices.tags },
    { label: 'Best pages', items: choices.bestPages }
  ].filter(group => group.items.length > 0)

  const retire = async () => {
    setBusy(true)
    setError(null)
    const result = await adminRequest(action, { redirect: target(value) })
    setBusy(false)
    if (!result.ok) {
      setError(result.message)
      return
    }
    setOpen(false)
    toast.success(result.replayed ? 'Already done. Nothing changed.' : `${name} was retired.`)
    router.push(doneHref)
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="text-destructive"
        onClick={() => setOpen(true)}
      >
        Retire
      </Button>
      <AlertDialog
        open={open}
        onOpenChange={next => {
          setOpen(next)
          if (!next) setError(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Retire {name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Within about a minute its page leaves the site and the sitemap, and its URL redirects
              to the page you choose. This is logged under your name.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Field data-invalid={error ? true : undefined}>
            <FieldLabel htmlFor={`${id}-redirect`}>Redirect to</FieldLabel>
            <Select
              value={value}
              onValueChange={next => {
                if (next) setValue(next)
              }}
              items={[DIRECTORY, ...groups.flatMap(group => group.items)]}
            >
              <SelectTrigger id={`${id}-redirect`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                <SelectItem value={DIRECTORY.value}>{DIRECTORY.label}</SelectItem>
                {groups.map(group => (
                  <SelectGroup key={group.label}>
                    <SelectLabel>{group.label}</SelectLabel>
                    {group.items.map(item => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
            {error ? <FieldError>{error}</FieldError> : null}
          </Field>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={event => {
                event.preventDefault()
                void retire()
              }}
            >
              Retire
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

'use client'

import { ArrowDown, ArrowUp, X } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useId, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle
} from '@/components/ui/card'
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList
} from '@/components/ui/combobox'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle
} from '@/components/ui/item'
import { adminRequest } from './api'

/**
 * A best page's pins (#405): the listings at the top of the page, in order, chosen from its live
 * pool (the listings its tag carries) less features of larger sites, at most its list size. Each
 * pin is a stock outline `Item` with move and remove buttons; a stock `Combobox` adds one.
 */

export interface PinChoice {
  id: string
  name: string
  slug: string
}

export function BestPagePins({
  candidates,
  listSize,
  pins,
  slug
}: {
  /** The pool the page may pin from, less features of larger sites. */
  candidates: readonly PinChoice[]
  listSize: number
  pins: readonly PinChoice[]
  slug: string
}) {
  const id = useId()
  const router = useRouter()
  const [chosen, setChosen] = useState<PinChoice[]>([...pins])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pinned = new Set(chosen.map(pin => pin.id))
  const available = candidates.filter(candidate => !pinned.has(candidate.id))
  const full = chosen.length >= listSize

  const move = (index: number, by: number) => {
    const next = [...chosen]
    const [pin] = next.splice(index, 1)
    if (!pin) return
    next.splice(index + by, 0, pin)
    setChosen(next)
    setError(null)
  }

  const save = async () => {
    setBusy(true)
    setError(null)
    const result = await adminRequest(`/api/admin/best-pages/${encodeURIComponent(slug)}/pins`, {
      expectedPins: pins.map(pin => ({ id: pin.id, slug: pin.slug })),
      pins: chosen.map(pin => ({ id: pin.id, slug: pin.slug }))
    })
    setBusy(false)
    if (!result.ok) {
      setError(result.message)
      toast.error(result.message)
      return
    }
    toast.success(result.replayed ? 'Already done. Nothing changed.' : 'Saved.')
    router.refresh()
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Pinned listings</CardTitle>
        <CardDescription>
          They take the top places, in this order. Up to {listSize}.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {chosen.length > 0 ? (
          <ItemGroup className="gap-2">
            {chosen.map((pin, index) => (
              <Item key={pin.id} variant="outline" size="sm">
                <ItemContent>
                  <ItemTitle>
                    {index + 1}. {pin.name}
                  </ItemTitle>
                  <ItemDescription className="font-mono">{pin.slug}</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Move ${pin.name} up`}
                    disabled={busy || index === 0}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUp />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Move ${pin.name} down`}
                    disabled={busy || index === chosen.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDown />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Unpin ${pin.name}`}
                    disabled={busy}
                    onClick={() => {
                      setChosen(chosen.filter(other => other.id !== pin.id))
                      setError(null)
                    }}
                  >
                    <X />
                  </Button>
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
        ) : null}
        <Field data-invalid={error ? true : undefined}>
          <FieldLabel htmlFor={`${id}-add`}>Add a listing</FieldLabel>
          <Combobox
            items={available}
            value={null}
            disabled={busy || full}
            onValueChange={(next: PinChoice | null) => {
              if (!next) return
              setChosen([...chosen, next])
              setError(null)
            }}
            itemToStringLabel={(item: PinChoice) => item.name}
            itemToStringValue={(item: PinChoice) => item.id}
          >
            <ComboboxInput id={`${id}-add`} className="w-full" disabled={busy || full} />
            <ComboboxContent>
              <ComboboxEmpty>No listings found.</ComboboxEmpty>
              <ComboboxList>
                {(item: PinChoice) => (
                  <ComboboxItem key={item.id} value={item}>
                    {item.name}
                  </ComboboxItem>
                )}
              </ComboboxList>
            </ComboboxContent>
          </Combobox>
          {error ? <FieldError>{error}</FieldError> : null}
        </Field>
      </CardContent>
      <CardFooter className="border-t pt-6">
        <div className="flex w-full flex-col gap-3 sm:flex-row sm:items-center">
          <Button disabled={busy} onClick={() => void save()}>
            Save pins
          </Button>
          <FieldDescription>Saves to production and is logged under your name.</FieldDescription>
        </div>
      </CardFooter>
    </Card>
  )
}

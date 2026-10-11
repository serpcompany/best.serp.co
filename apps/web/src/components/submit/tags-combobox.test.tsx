import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Combobox, ComboboxChip, ComboboxChips, ComboboxValue } from '@/components/ui/combobox'
import { type TagChoice, TagsCombobox } from './tags-combobox'

const choices: TagChoice[] = [
  { category: 'design', categoryName: 'Design', label: 'Mockups', slug: 'mockups' },
  { category: 'design', categoryName: 'Design', label: 'Whiteboards', slug: 'whiteboards' },
  { category: 'writing', categoryName: 'Writing', label: 'Note Taking', slug: 'note-taking' }
]

/** Every chip-remove `<button>` in `html`. */
function removeButtons(html: string): string[] {
  return html.match(/<button[^>]*data-slot="combobox-chip-remove"[^>]*>.*?<\/button>/gu) ?? []
}

describe('the Tags field’s chips (#370)', () => {
  const html = renderToStaticMarkup(
    <TagsCombobox
      id="tags"
      choices={choices}
      value={['mockups', 'note-taking', 'retired-tag']}
      onValueChange={() => {}}
    />
  )

  it('names each chip’s remove button after its tag, a retired one by its slug', () => {
    expect(removeButtons(html).map(button => button.match(/aria-label="([^"]*)"/u)?.[1])).toEqual([
      'Remove Mockups',
      'Remove Note Taking',
      'Remove retired-tag'
    ])
  })

  it('renders the stock chip’s remove button otherwise unchanged', () => {
    const stock = renderToStaticMarkup(
      <Combobox multiple value={['Mockups']}>
        <ComboboxChips>
          <ComboboxValue>
            {(chosen: string[]) =>
              chosen.map(label => <ComboboxChip key={label}>{label}</ComboboxChip>)
            }
          </ComboboxValue>
        </ComboboxChips>
      </Combobox>
    )
    const [stockButton] = removeButtons(stock)
    const drifted =
      'The chip-remove button copied in tags-combobox.tsx no longer matches the stock one in ' +
      'components/ui/combobox.tsx. If the stock button now has its own name, delete the copy ' +
      'and render the stock button; otherwise update the copy to match it'
    expect(stockButton, drifted).toBeDefined()
    expect(removeButtons(html)[0]?.replace(' aria-label="Remove Mockups"', ''), drifted).toBe(
      stockButton
    )
  })
})

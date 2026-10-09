'use client'

import { Check, Copy } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea
} from '@/components/ui/input-group'

/**
 * A read-only embed snippet with its copy button (#188), the one box the badge step, the claim
 * dialog and the account's badge drawer share. `label` names the snippet for screen readers.
 */
export function EmbedCode({ code, label }: { code: string; label: string }) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error('Couldn’t copy. Select the code and copy it.')
    }
  }

  return (
    <InputGroup>
      <InputGroupTextarea
        readOnly
        value={code}
        aria-label={label}
        wrap="off"
        spellCheck={false}
        className="font-mono text-xs md:text-xs"
      />
      <InputGroupAddon align="block-end">
        <InputGroupButton variant="outline" size="sm" className="ml-auto" onClick={copy}>
          {copied ? <Check /> : <Copy />}
          {copied ? 'Copied' : 'Copy code'}
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  )
}

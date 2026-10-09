'use client'

import { Check, Copy } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'

interface CopyButtonProps {
  text: string
  variant?: 'default' | 'terminal'
}

/**
 * Renders a button that copies text to the clipboard
 */
export function CopyButton({ text, variant = 'default' }: CopyButtonProps) {
  const [copied, setCopied] = useState(false)

  /**
   * Copies the text to the clipboard and shows a confirmation
   */
  const handleCopy = () => {
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <Button
      variant={variant === 'terminal' ? 'outline' : 'secondary'}
      size="icon-lg"
      onClick={handleCopy}
      aria-label="Copy to clipboard"
    >
      {copied ? (
        <Check className="size-4 text-success" />
      ) : (
        <Copy className="size-4 text-muted-foreground" />
      )}
    </Button>
  )
}

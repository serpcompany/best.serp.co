'use client'

import { Check, Copy } from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/lib/utils'

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
    <button
      type="button"
      onClick={handleCopy}
      className={cn(
        'shrink-0 rounded-lg p-2.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        variant === 'terminal'
          ? 'border border-border bg-background hover:bg-accent'
          : 'border border-border/50 bg-muted hover:bg-muted/80'
      )}
      aria-label="Copy to clipboard"
    >
      {copied ? (
        <Check className="size-4 text-success" />
      ) : (
        <Copy className="size-4 text-muted-foreground" />
      )}
    </button>
  )
}

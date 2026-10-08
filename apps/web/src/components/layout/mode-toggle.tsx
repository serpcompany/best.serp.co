'use client'

import { Moon, Sun } from 'lucide-react'
import { useTheme } from 'next-themes'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'

/**
 * Switches between the light and dark themes. Once mounted (the theme is only known in the
 * browser), its label names the action, which also tells screen readers the current theme.
 */
export function ModeToggle() {
  const { resolvedTheme, theme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const activeTheme = resolvedTheme || theme
  const label = mounted
    ? activeTheme === 'dark'
      ? 'Switch to light theme'
      : 'Switch to dark theme'
    : 'Toggle theme'

  return (
    <Button
      variant="ghost"
      size="icon"
      title={mounted ? label : undefined}
      onClick={() => setTheme(activeTheme === 'light' ? 'dark' : 'light')}
    >
      <Sun className="h-[1.2rem] w-[1.2rem] rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
      <Moon className="absolute h-[1.2rem] w-[1.2rem] rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
      <span className="sr-only">{label}</span>
    </Button>
  )
}

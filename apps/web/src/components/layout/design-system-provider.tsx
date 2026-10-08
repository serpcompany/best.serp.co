import type { ThemeProviderProps } from 'next-themes'
import type { CSSProperties } from 'react'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ThemeProvider } from './theme-provider'

/**
 * Stock Sonner reads `var(--popover)` and friends as whole colors; this theme keeps HSL
 * components in those variables (`--popover: 0 0% 100%`), so the toaster gets the theme's
 * whole colors (`--color-popover`). #186's base-nova theme stores whole colors, and this goes.
 */
const toasterColors = {
  '--normal-bg': 'var(--color-popover)',
  '--normal-text': 'var(--color-popover-foreground)',
  '--normal-border': 'var(--color-border)',
  // The style prop replaces stock's whole object, so its radius comes along.
  '--border-radius': 'var(--radius)'
} as CSSProperties

interface DesignSystemProviderProperties extends ThemeProviderProps {
  monitoringSampleRate?: number
}

export const DesignSystemProvider = ({
  children,
  monitoringSampleRate,
  ...properties
}: DesignSystemProviderProperties) => {
  return (
    <ThemeProvider {...properties}>
      <TooltipProvider>{children}</TooltipProvider>
      <Toaster style={toasterColors} />
    </ThemeProvider>
  )
}

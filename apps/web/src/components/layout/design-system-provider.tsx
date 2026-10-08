import type { ThemeProviderProps } from 'next-themes'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ThemeProvider } from './theme-provider'

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
      <Toaster />
    </ThemeProvider>
  )
}

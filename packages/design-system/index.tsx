import { IS_DEVELOPMENT } from '@serpdirectory/utils/environment'
import type { ThemeProviderProps } from 'next-themes'
import { Toaster } from './components/shadcn/sonner'
import { TooltipProvider } from './components/shadcn/tooltip'
import { ThemeProvider } from './providers/theme'

const ENABLE_VERCEL_TOOLBAR = process.env.NEXT_PUBLIC_ENABLE_VERCEL_TOOLBAR === 'true'
const VercelToolbar = ENABLE_VERCEL_TOOLBAR ? require('@vercel/toolbar/next').VercelToolbar : null

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
      {IS_DEVELOPMENT && VercelToolbar ? <VercelToolbar /> : null}
    </ThemeProvider>
  )
}

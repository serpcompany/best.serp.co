import { Geist, Geist_Mono } from 'next/font/google'
import { cn } from './utils'

/** Geist and Geist Mono through `next/font`, with the variable names the other SERP sites use. */
const geistSans = Geist({ variable: '--font-sans', subsets: ['latin'] })
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] })

export const fonts = cn(
  geistSans.variable,
  geistMono.variable,
  'touch-manipulation font-sans antialiased'
)

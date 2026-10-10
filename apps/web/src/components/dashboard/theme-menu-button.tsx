'use client'

import { Moon, Sun } from 'lucide-react'
import { useTheme } from 'next-themes'
import { useSyncExternalStore } from 'react'
import { SidebarMenuButton } from '@/components/ui/sidebar'
import { FULL_SIZE_TARGET_CLASS } from './nav-main'

/** serplists' `ThemeIcon`: the sun in light mode and the moon in dark, swapped by `.dark`. */
export function ThemeIcon() {
  return (
    <span className="relative size-4" aria-hidden="true">
      <Sun className="absolute size-4 scale-100 rotate-0 transition-all dark:scale-0 dark:-rotate-90" />
      <Moon className="absolute size-4 scale-0 rotate-90 transition-all dark:scale-100 dark:rotate-0" />
    </span>
  )
}

const subscribeToNothing = () => () => {}

/**
 * serplists' `useThemeToggle`, on next-themes. The server and the hydrating render read light,
 * as serplists' server snapshot does, so the labels never mismatch; the client then reads the
 * resolved theme.
 */
export function useThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme()
  const hydrated = useSyncExternalStore(
    subscribeToNothing,
    () => true,
    () => false
  )
  const isDark = hydrated && resolvedTheme === 'dark'
  return {
    accessibleLabel: isDark ? 'Switch to light mode' : 'Switch to dark mode',
    label: isDark ? 'Dark mode' : 'Light mode',
    toggle: () => setTheme(isDark ? 'light' : 'dark')
  }
}

/** serplists' `ThemeMenuButton`: the theme row in the sidebar footer, above the account menu. */
export function ThemeMenuButton() {
  const { accessibleLabel, label, toggle } = useThemeToggle()
  return (
    <SidebarMenuButton
      aria-label={accessibleLabel}
      className={FULL_SIZE_TARGET_CLASS}
      tooltip={label}
      onClick={toggle}
      type="button"
    >
      <ThemeIcon />
      <span>{label}</span>
    </SidebarMenuButton>
  )
}

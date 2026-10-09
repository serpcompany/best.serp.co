'use client'

import { MonitorIcon, Moon, MoonIcon, Sun, SunIcon } from 'lucide-react'
import { useTheme } from 'next-themes'
import { Button } from '@/components/ui/button'
import {
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem
} from '@/components/ui/dropdown-menu'

/** Switches between the light and dark themes (serp.co's `theme-toggle.tsx`, #256). */
export function ThemeToggle({ className }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme()
  return (
    <Button
      variant="ghost"
      size="icon"
      className={className}
      onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
    >
      <Sun aria-hidden="true" className="dark:hidden" />
      <Moon aria-hidden="true" className="hidden dark:block" />
      <span className="sr-only">Toggle dark mode</span>
    </Button>
  )
}

const themeChoices = [
  { theme: 'light', label: 'Light', icon: SunIcon },
  { theme: 'dark', label: 'Dark', icon: MoonIcon },
  { theme: 'system', label: 'System', icon: MonitorIcon }
] as const

function ThemeIcon() {
  return (
    <>
      <SunIcon
        aria-hidden="true"
        className="scale-100 rotate-0 transition-all dark:scale-0 dark:-rotate-90"
      />
      <MoonIcon
        aria-hidden="true"
        className="absolute scale-0 rotate-90 transition-all dark:scale-100 dark:rotate-0"
      />
    </>
  )
}

/**
 * The account menu's theme row (zenbujapanese.com's `ThemeMenuRow`, #286): "Theme" and a
 * Light, Dark and System switch.
 */
export function ThemeMenuRow() {
  const { theme, setTheme } = useTheme()
  return (
    <DropdownMenuGroup className="flex items-center justify-between gap-3 py-0.5 pr-0.5 pl-1.5">
      <DropdownMenuLabel className="relative flex items-center gap-1.5 p-0 text-sm font-normal text-foreground [&_svg]:size-4 [&_svg]:text-muted-foreground">
        <ThemeIcon />
        Theme
      </DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={theme}
        onValueChange={setTheme}
        className="flex gap-px rounded-full p-0.5 ring-1 ring-border"
      >
        {themeChoices.map(({ theme: value, label, icon: Icon }) => (
          <DropdownMenuRadioItem
            key={value}
            value={value}
            label={label}
            className="size-7 justify-center rounded-full p-0 text-muted-foreground *:data-[slot=dropdown-menu-radio-item-indicator]:hidden focus:text-foreground data-checked:bg-muted data-checked:text-foreground data-checked:ring-1 data-checked:ring-foreground/10 [&_svg:not([class*='size-'])]:size-3.5"
          >
            <Icon aria-hidden="true" />
            <span className="sr-only">{label}</span>
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </DropdownMenuGroup>
  )
}

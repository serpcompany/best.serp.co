// One class merger: shadcn's `cn` package, which components/ui/ imports too (#186).
export { cn } from 'cn'

export const capitalize = (str: string) => str.charAt(0).toUpperCase() + str.slice(1)

import NextForbidden from 'next/dist/client/components/builtin/forbidden'

/** `forbidden()` in `/account` and `/admin`: Next.js's own 403 page, in the page's one `<main>`. */
export default function DashboardForbidden() {
  return (
    <main className="flex min-h-screen flex-col">
      <NextForbidden />
    </main>
  )
}

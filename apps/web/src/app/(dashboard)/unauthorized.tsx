import NextUnauthorized from 'next/dist/client/components/builtin/unauthorized'

/** `unauthorized()` in `/account` and `/admin`: Next.js's own 401 page, in the page's one `<main>`. */
export default function DashboardUnauthorized() {
  return (
    <main className="flex min-h-screen flex-col">
      <NextUnauthorized />
    </main>
  )
}

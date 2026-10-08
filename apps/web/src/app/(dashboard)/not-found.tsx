import { NotFoundContent, notFoundMetadata } from '@/components/layout/not-found-content'

export const metadata = notFoundMetadata

/** `notFound()` in `/account` and `/admin`: the 404 without the public chrome. */
export default function DashboardNotFound() {
  return (
    <main className="flex min-h-screen flex-col">
      <NotFoundContent />
    </main>
  )
}

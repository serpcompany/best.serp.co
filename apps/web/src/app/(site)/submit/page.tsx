import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { SubmitForm } from '@/components/submit/submit-form'
import { getSessionUser } from '@/lib/auth/server'
import { getActiveCategories } from '@/lib/catalog/repository'
import { getRoute } from '@/lib/routing/routes'
import { generateBaseMetadata } from '@/lib/seo/seo-config'
import { toSummary } from '@/lib/submissions/http'
import { getOwnSubmission, insecureLogosAllowed } from '@/lib/submissions/repository'

// Noindex and robots-disallowed, from the route registry (#167).
export const metadata: Metadata = generateBaseMetadata({
  title: 'Submit to SERP',
  description: 'Submit your software, AI tool, company, resource, or SERP project to SERP.',
  path: getRoute('submit')
})

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

type SubmitPageProps = {
  searchParams: Promise<{ edit?: string | string[]; url?: string | string[] }>
}

function first(value: string | string[] | undefined): string | null {
  const text = Array.isArray(value) ? value[0] : value
  return text ? text.slice(0, 2048) : null
}

/**
 * `/submit` (serpcompany/best.serp.co#63, #70 screen 2): the product details form. It can be
 * filled in signed out; saving needs an account. `?url=` starts from a website, and
 * `?edit=<id>` edits the owner's saved draft (2b "Edit details").
 */
export default async function SubmitPage({ searchParams }: SubmitPageProps) {
  const params = await searchParams
  const [categories, user] = await Promise.all([getActiveCategories(), getSessionUser()])
  const edit = first(params.edit)
  let editing = null
  if (edit) {
    if (!user) redirect(`/login/?callbackUrl=${encodeURIComponent(`/submit/?edit=${edit}`)}`)
    const submission = UUID.test(edit) ? await getOwnSubmission(edit, user.id) : null
    if (submission && (submission.status === 'draft' || submission.status === 'pending_badge')) {
      editing = toSummary(submission)
    }
  }

  return (
    <SubmitForm
      categories={categories.map(category => ({ label: category.name, slug: category.slug }))}
      editing={editing}
      initialUrl={first(params.url)}
      allowInsecureLogos={await insecureLogosAllowed()}
      signedInEmail={user?.email ?? null}
      signedInUserId={user?.id ?? null}
    />
  )
}

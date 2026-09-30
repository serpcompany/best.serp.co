import { type CategoryOption, D1SubmissionForm } from './d1-submission-form'

export function SubmitPageSurface({
  categoryOptions
}: {
  categoryOptions: readonly CategoryOption[]
}) {
  return (
    <section className="container mx-auto max-w-3xl px-6 py-16">
      <D1SubmissionForm categoryOptions={categoryOptions} />
    </section>
  )
}

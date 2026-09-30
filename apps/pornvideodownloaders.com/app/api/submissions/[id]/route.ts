import { submissionCapabilitySchema } from '@serpdirectory/web-core/forms/submission-contract'
import { NextResponse } from 'next/server'
import { submissionBadgeTargets } from '@/lib/submissions/presentation'
import { getSubmission, isSubmissionError } from '@/lib/submissions/repository'

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await context.params
  const parsed = submissionCapabilitySchema.safeParse({
    token: new URL(request.url).searchParams.get('token')
  })
  if (!parsed.success) {
    return NextResponse.json({ code: 'not_found', error: 'Submission not found.' }, { status: 404 })
  }
  try {
    const state = await getSubmission(id, parsed.data.token)
    return NextResponse.json(
      { ...state, ...submissionBadgeTargets(state.slug) },
      { headers: { 'Cache-Control': 'no-store' } }
    )
  } catch (error) {
    if (isSubmissionError(error)) {
      return NextResponse.json({ code: error.code, error: error.message }, { status: error.status })
    }
    return NextResponse.json(
      { code: 'internal_error', error: 'Unable to read submission.' },
      { status: 500 }
    )
  }
}

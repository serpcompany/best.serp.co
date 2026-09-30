import { submissionCapabilitySchema } from '@serpdirectory/web-core/forms/submission-contract'
import { NextResponse } from 'next/server'
import { verifyFeaturedBadge } from '@/lib/submissions/badge-verifier'
import { submissionBadgeTargets } from '@/lib/submissions/presentation'
import {
  beginVerification,
  finishVerification,
  isSubmissionError
} from '@/lib/submissions/repository'

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await context.params
  try {
    const parsed = submissionCapabilitySchema.safeParse(await request.json())
    if (!parsed.success) {
      return NextResponse.json(
        { code: 'not_found', error: 'Submission not found.' },
        { status: 404 }
      )
    }
    const state = await beginVerification(id, parsed.data.token)
    if (state.status !== 'pending_badge') {
      return NextResponse.json({ ...state, ...submissionBadgeTargets(state.slug) })
    }
    const targets = submissionBadgeTargets(state.slug)
    const result = await verifyFeaturedBadge(state.website, targets)
    const updated = await finishVerification(id, parsed.data.token, result)
    return NextResponse.json(
      { ...updated, ...targets },
      { status: result.ok ? 200 : 422, headers: { 'Cache-Control': 'no-store' } }
    )
  } catch (error) {
    if (isSubmissionError(error)) {
      return NextResponse.json({ code: error.code, error: error.message }, { status: error.status })
    }
    return NextResponse.json(
      { code: 'internal_error', error: 'Unable to verify badge.' },
      { status: 500 }
    )
  }
}

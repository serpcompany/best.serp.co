import { submissionRequestSchema } from '@serpdirectory/web-core/forms/submission-contract'
import { NextResponse } from 'next/server'
import { submissionBadgeTargets } from '@/lib/submissions/presentation'
import {
  consumeSubmissionRateLimit,
  createSubmission,
  isSubmissionError
} from '@/lib/submissions/repository'

function failure(error: unknown): NextResponse {
  if (isSubmissionError(error)) {
    return NextResponse.json({ code: error.code, error: error.message }, { status: error.status })
  }
  return NextResponse.json(
    {
      code: 'internal_error',
      error: 'Unable to create submission.'
    },
    { status: 500 }
  )
}

export async function POST(request: Request): Promise<NextResponse> {
  const length = Number(request.headers.get('content-length') || '0')
  if (length > 32_000) {
    return NextResponse.json(
      { code: 'payload_too_large', error: 'Submission is too large.' },
      { status: 413 }
    )
  }
  try {
    await consumeSubmissionRateLimit(request.headers.get('cf-connecting-ip') || 'local-development')
    const parsed = submissionRequestSchema.safeParse(await request.json())
    if (!parsed.success) {
      return NextResponse.json(
        { code: 'invalid_submission', error: 'Check the submitted fields.' },
        { status: 400 }
      )
    }
    const submission = await createSubmission(parsed.data)
    return NextResponse.json(
      { ...submission, ...submissionBadgeTargets(submission.slug) },
      { status: 201, headers: { 'Cache-Control': 'no-store' } }
    )
  } catch (error) {
    return failure(error)
  }
}

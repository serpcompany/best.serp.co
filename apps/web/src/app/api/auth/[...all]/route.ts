import { handleAuthRequest } from '@/lib/auth/server'

// Better Auth endpoints (sign-in code, sign-in, session, sign-out): docs/ACCOUNTS.md.
export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  return handleAuthRequest(request)
}

export async function POST(request: Request): Promise<Response> {
  return handleAuthRequest(request)
}

import { handleAuthRequest } from '@/lib/auth/server'

// Better Auth endpoints (sign-in code, sign-in, session, sign-out): docs/ARCHITECTURE.md#accounts.
export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  return handleAuthRequest(request)
}

export async function POST(request: Request): Promise<Response> {
  return handleAuthRequest(request)
}

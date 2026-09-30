import NextAuth from 'next-auth'
import type { NextAuthConfig, Session } from 'next-auth'
import GitHub from 'next-auth/providers/github'

function isGitHubAuthConfigured(): boolean {
  return Boolean(
    process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET && process.env.NEXTAUTH_SECRET
  )
}

const authConfig = {
  pages: {
    signIn: '/login'
  },
  providers: isGitHubAuthConfigured()
    ? [
        GitHub({
          clientId: process.env.GITHUB_CLIENT_ID ?? '',
          clientSecret: process.env.GITHUB_CLIENT_SECRET ?? ''
        })
      ]
    : [],
  secret: process.env.NEXTAUTH_SECRET,
  session: {
    strategy: 'jwt'
  }
} satisfies NextAuthConfig

const nextAuth = NextAuth(authConfig)

export const { handlers } = nextAuth

export async function auth(): Promise<Session | null> {
  return nextAuth.auth()
}

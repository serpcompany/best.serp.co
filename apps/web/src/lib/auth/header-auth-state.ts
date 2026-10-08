export interface HeaderAuthState {
  isAuthenticated?: boolean
  isConfigured?: boolean
  user?: {
    image?: string | null
    name?: string | null
  }
}

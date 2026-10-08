import 'server-only'

import { cache } from 'react'
import type { AccountOverview } from '@/db/account'
import { accountOperations } from './runtime'

/** The user's submissions and listings, read once per request (the layout and the page share it). */
export const getAccountOverview = cache(
  async (userId: string): Promise<AccountOverview> => (await accountOperations()).overview(userId)
)

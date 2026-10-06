import 'server-only'

import type { AccountOverview } from '@serpdirectory/data-ops/account'
import { cache } from 'react'
import { accountOperations } from './runtime'

/** The user's submissions and listings, read once per request (the layout and the page share it). */
export const getAccountOverview = cache(
  async (userId: string): Promise<AccountOverview> => (await accountOperations()).overview(userId)
)

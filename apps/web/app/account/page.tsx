import { AccountPageRoute } from '@serpdirectory/web-core/account-page'
import { getRoute } from '@serpdirectory/web-core/routes'
import { redirect } from 'next/navigation'
import type { ReactElement } from 'react'
import { getSafeCallbackUrl, getSession } from '@/lib/auth'
import { requireRouteFeature } from '@/lib/route-feature-gates'
import { isStaticExportBuild } from '@/lib/runtime-mode'

export default async function AccountPage(): Promise<ReactElement> {
  requireRouteFeature('showAuth')

  if (isStaticExportBuild()) {
    return <AccountPageRoute isStaticExportBuild />
  }

  const session = await getSession()

  if (!session?.user) {
    redirect(
      `${getRoute('login')}?callbackUrl=${encodeURIComponent(getSafeCallbackUrl('/account'))}`
    )
  }

  return <AccountPageRoute user={session.user} />
}

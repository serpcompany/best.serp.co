import { Alert, AlertDescription, AlertTitle } from '@serpdirectory/design-system/alert'
import { WebsiteError as SharedWebsiteError } from './website-error'

export function WebsiteErrorRoute() {
  return <SharedWebsiteError slots={{ Alert, AlertDescription, AlertTitle }} />
}

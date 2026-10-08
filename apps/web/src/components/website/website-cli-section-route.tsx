import { CopyButton } from '../ui/copy-button'
import {
  WebsiteCliSection as SharedWebsiteCliSection,
  type WebsiteCliSectionProps as SharedWebsiteCliSectionProps
} from './website-cli-section'

interface WebsiteCliSectionRouteProps {
  website: SharedWebsiteCliSectionProps['website']
}

export function WebsiteCliSectionRoute({ website }: WebsiteCliSectionRouteProps) {
  return <SharedWebsiteCliSection website={website} slots={{ CopyButton }} />
}

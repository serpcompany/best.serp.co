import { AlertTriangle } from 'lucide-react'
import Link from 'next/link'
import type { ComponentType, ReactNode } from 'react'
import { getCanonicalListingListRoute } from '../routes'

type AlertProps = {
  children: ReactNode
  className?: string
  variant?: 'destructive'
}

type AlertSectionProps = {
  children: ReactNode
}

export interface WebsiteErrorProps {
  slots: {
    Alert: ComponentType<AlertProps>
    AlertDescription: ComponentType<AlertSectionProps>
    AlertTitle: ComponentType<AlertSectionProps>
  }
}

export function WebsiteError({
  slots: { Alert, AlertDescription, AlertTitle }
}: WebsiteErrorProps) {
  return (
    <div className="container mx-auto px-6 py-8">
      <Alert variant="destructive" className="mb-6">
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle>Error loading website</AlertTitle>
        <AlertDescription>
          There was a problem loading this website. Please try again later or{' '}
          <Link href={getCanonicalListingListRoute()} className="underline font-medium">
            return to the websites list
          </Link>
          .
        </AlertDescription>
      </Alert>
    </div>
  )
}

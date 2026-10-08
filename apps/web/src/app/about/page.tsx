import { Button } from '@serpdirectory/design-system/button'
import {
  AboutStaticPage,
  generateAboutPageMetadata
} from '@serpdirectory/web-core/static-pages/about-page'
import { Card, CardContent, CardHeader, CardTitle } from '@serpdirectory/web-core/ui/card'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getAboutPage } from '@/lib/content-loader'

export async function generateMetadata(): Promise<Metadata> {
  return generateAboutPageMetadata(await getAboutPage())
}

export default async function AboutPage() {
  const aboutPage = await getAboutPage()

  if (!aboutPage) {
    notFound()
  }

  return (
    <AboutStaticPage
      aboutPage={aboutPage}
      slots={{ Button, Card, CardContent, CardHeader, CardTitle }}
    />
  )
}

import { Button } from '@serpdirectory/design-system/button'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { AboutStaticPage, generateAboutPageMetadata } from '@/components/static-pages/about-page'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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

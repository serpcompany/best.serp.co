import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { SiteCard, SiteCardHeader } from '@/components/directory/site-card'
import { AboutStaticPage, generateAboutPageMetadata } from '@/components/static-pages/about-page'
import { Button } from '@/components/ui/button'
import { CardContent, CardTitle } from '@/components/ui/card'
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
      slots={{ Button, Card: SiteCard, CardContent, CardHeader: SiteCardHeader, CardTitle }}
    />
  )
}

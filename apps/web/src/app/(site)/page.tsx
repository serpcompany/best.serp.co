import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getHomePageData } from '@/actions/get-home-page-data'
import { HomePageCanonicalTags, HomePageRoute, homePageMetadata } from '@/components/home/home-page'

export function generateMetadata(): Metadata {
  return homePageMetadata()
}

/** The homepage shows page 1 of the directory; later pages live at `/products/?page=N`. */
export default async function Home() {
  const data = await getHomePageData()
  if (!data) notFound()

  return (
    <>
      <HomePageCanonicalTags />
      <HomePageRoute data={data} />
    </>
  )
}

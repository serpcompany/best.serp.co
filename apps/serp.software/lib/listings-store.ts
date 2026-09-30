import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { resolveFromRoot } from './server-utils'

const LISTINGS_PATH = path.join(resolveFromRoot('data'), 'listings.json')

export function readListings(): unknown[] {
  try {
    return JSON.parse(readFileSync(LISTINGS_PATH, 'utf-8')) as unknown[]
  } catch {
    return []
  }
}

export function appendListing(listing: unknown): void {
  const listings = readListings()
  writeFileSync(LISTINGS_PATH, JSON.stringify([...listings, listing], null, 2))
}
